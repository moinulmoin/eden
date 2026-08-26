#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];
const releasePackages = [
  {
    name: "@moinulmoin/eden-definitions",
    directory: "packages/definitions",
  },
  {
    name: "@moinulmoin/eden-compiler",
    directory: "packages/compiler",
  },
  {
    name: "@moinulmoin/eden-runtime-cloudflare",
    directory: "packages/runtime-cloudflare",
  },
  {
    name: "@moinulmoin/eden",
    directory: "packages/cli",
  },
];
const releasePackageNames = new Set(releasePackages.map(({ name }) => name));
const unsafeDependency = /^(?:workspace:|file:|link:|\.{1,2}\/|\/)/u;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

function fail(message) {
  throw new Error(message);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    fail(
      [
        `${executable} ${args.join(" ")} exited ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (options.echo) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  return result;
}

function insideRepository(path, label) {
  const absolute = resolve(repositoryRoot, path);
  const fromRoot = relative(repositoryRoot, absolute);
  if (
    fromRoot.length === 0 ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    fail(`${label} must be a non-root path inside the repository`);
  }
  return absolute;
}

function validateVersion(version) {
  if (!exactVersion.test(version)) {
    fail(`release version must be an exact x.y.z value, received ${version}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validatePackage(packageJson, expectedName, version, label) {
  if (packageJson.name !== expectedName) {
    fail(`${label} name is ${String(packageJson.name)}, expected ${expectedName}`);
  }
  if (packageJson.version !== version) {
    fail(`${label} version is ${String(packageJson.version)}, expected ${version}`);
  }
  if (packageJson.private === true) fail(`${label} is private`);

  for (const section of dependencySections) {
    for (const [name, spec] of Object.entries(packageJson[section] ?? {})) {
      if (typeof spec !== "string" || unsafeDependency.test(spec)) {
        fail(`${label} ${section}.${name} is not registry-safe: ${String(spec)}`);
      }
      if (releasePackageNames.has(name) && spec !== version) {
        fail(`${label} ${section}.${name} must equal ${version}, received ${spec}`);
      }
    }
  }
}

async function fileIntegrity(path) {
  const bytes = await readFile(path);
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function prepare(version, outputPath) {
  validateVersion(version);
  const rootPackage = await readJson(join(repositoryRoot, "package.json"));
  if (rootPackage.version !== version) {
    fail(`root package version is ${String(rootPackage.version)}, expected ${version}`);
  }

  const outputDirectory = insideRepository(outputPath, "release output directory");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const packages = [];

  for (const releasePackage of releasePackages) {
    const packageDirectory = join(repositoryRoot, releasePackage.directory);
    const sourcePackage = await readJson(join(packageDirectory, "package.json"));
    validatePackage(
      sourcePackage,
      releasePackage.name,
      version,
      `${releasePackage.directory}/package.json`,
    );

    const before = new Set(await readdir(outputDirectory));
    run(
      "pnpm",
      ["pack", "--pack-destination", outputDirectory],
      { cwd: packageDirectory, echo: true },
    );
    const created = (await readdir(outputDirectory)).filter(
      (entry) => !before.has(entry) && entry.endsWith(".tgz"),
    );
    if (created.length !== 1) {
      fail(`${releasePackage.name} produced ${String(created.length)} tarballs`);
    }

    const tarballPath = join(outputDirectory, created[0]);
    const packedManifest = run(
      "tar",
      ["-xOf", tarballPath, "package/package.json"],
    );
    const packedPackage = JSON.parse(packedManifest.stdout);
    validatePackage(
      packedPackage,
      releasePackage.name,
      version,
      `${created[0]} package.json`,
    );
    packages.push({
      name: releasePackage.name,
      tarball: relative(repositoryRoot, tarballPath),
      integrity: await fileIntegrity(tarballPath),
    });
  }

  const manifestPath = join(outputDirectory, "release-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version, packages }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Prepared ${packages.length} packages in ${relative(repositoryRoot, outputDirectory)}`);
  console.log(`Manifest: ${relative(repositoryRoot, manifestPath)}`);
}

async function loadManifest(manifestPath) {
  const absoluteManifest = insideRepository(manifestPath, "release manifest");
  const manifest = await readJson(absoluteManifest);
  validateVersion(manifest.version);
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== releasePackages.length) {
    fail("release manifest does not contain the complete package graph");
  }

  for (let index = 0; index < releasePackages.length; index += 1) {
    const expected = releasePackages[index];
    const record = manifest.packages[index];
    if (record?.name !== expected.name) {
      fail(`release manifest package ${String(index)} must be ${expected.name}`);
    }
    if (typeof record.tarball !== "string" || typeof record.integrity !== "string") {
      fail(`release manifest entry for ${expected.name} is incomplete`);
    }
    record.absoluteTarball = insideRepository(record.tarball, `${expected.name} tarball`);
    const observedIntegrity = await fileIntegrity(record.absoluteTarball);
    if (observedIntegrity !== record.integrity) {
      fail(`${expected.name} tarball integrity changed after preparation`);
    }
  }
  return manifest;
}

function registryIntegrity(name, version) {
  const result = run(
    "npm",
    ["view", `${name}@${version}`, "dist.integrity", "--json"],
    { allowFailure: true },
  );
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    if (typeof value !== "string" || !value.startsWith("sha512-")) {
      fail(`npm returned an invalid integrity for ${name}@${version}`);
    }
    return value;
  }
  if (/E404|404 Not Found/u.test(`${result.stdout}\n${result.stderr}`)) {
    return undefined;
  }
  fail(`npm view failed for ${name}@${version}\n${result.stderr}`);
}

function requireOidc() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL === undefined ||
    process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined
  ) {
    fail("refusing to publish without GitHub Actions OIDC credentials");
  }
  const npmVersion = run("npm", ["--version"]).stdout.trim();
  const [major, minor] = npmVersion.split(".").map(Number);
  if (major < 11 || (major === 11 && minor < 5)) {
    fail(`npm ${npmVersion} cannot use trusted publishing; npm >=11.5.1 is required`);
  }
}

async function waitForRegistry(record, version) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const publishedIntegrity = registryIntegrity(record.name, version);
    if (publishedIntegrity === record.integrity) return;
    if (publishedIntegrity !== undefined) {
      fail(`${record.name}@${version} exists with different bytes`);
    }
    if (attempt < 12) await delay(5_000);
  }
  fail(`${record.name}@${version} did not become visible on npm`);
}

async function publish(manifestPath) {
  const manifest = await loadManifest(manifestPath);
  let oidcChecked = false;
  for (const record of manifest.packages) {
    const publishedIntegrity = registryIntegrity(record.name, manifest.version);
    if (publishedIntegrity === record.integrity) {
      console.log(`Verified existing ${record.name}@${manifest.version}; skipping publish`);
      continue;
    }
    if (publishedIntegrity !== undefined) {
      fail(`${record.name}@${manifest.version} exists with different bytes`);
    }
    if (!oidcChecked) {
      requireOidc();
      oidcChecked = true;
    }
    run("npm", ["publish", record.absoluteTarball, "--access", "public"], { echo: true });
    await waitForRegistry(record, manifest.version);
    console.log(`Published ${record.name}@${manifest.version}`);
  }
}

async function verify(manifestPath) {
  const manifest = await loadManifest(manifestPath);
  for (const record of manifest.packages) {
    const publishedIntegrity = registryIntegrity(record.name, manifest.version);
    if (publishedIntegrity !== record.integrity) {
      fail(`${record.name}@${manifest.version} does not match the prepared tarball`);
    }
    console.log(`Verified ${record.name}@${manifest.version}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare" && args.length === 2) {
    await prepare(args[0], args[1]);
    return;
  }
  if (command === "publish" && args.length === 1) {
    await publish(args[0]);
    return;
  }
  if (command === "verify" && args.length === 1) {
    await verify(args[0]);
    return;
  }
  fail(
    "usage: release-packages.mjs prepare <version> <output-dir> | publish <manifest> | verify <manifest>",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
