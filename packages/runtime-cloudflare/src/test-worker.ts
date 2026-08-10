import { EdenSession } from "./session.js";
import { handleEdenRequest, type EdenWorkerEnvironment } from "./http-host.js";
import "./model-adapter-internal.js";

export { EdenSession };
export {
  configureEdenArtifact,
  readConfiguredEdenArtifact,
} from "./artifact-runtime.js";

export default {
  fetch(
    request: Request,
    env: EdenWorkerEnvironment,
  ): Promise<Response> {
    return handleEdenRequest(request, env);
  },
};
