# @moinulmoin/eden

CLI for Eden Deploy and Eden Agent.

```sh
npm install --global @moinulmoin/eden@0.1.0
eden --help
```

The package requires Node `>=24.17.0 <25`. pnpm and Bun may also install the
package; Bun is an installer, not the Eden runtime.

- `eden preflight`, `eden deploy`, `eden destroy`: host an existing Eve project
  on Cloudflare without rewriting its source.
- `eden agent`: author and operate a Cloudflare-native Eden Agent.

Full setup, requirements, architecture, and validation guidance:
<https://github.com/moinulmoin/eden#readme>

Apache-2.0. See the packaged `LICENSE` and `NOTICE` files.
