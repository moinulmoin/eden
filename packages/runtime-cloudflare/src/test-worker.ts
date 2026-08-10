import { EdenSession } from "./session.js";
import "./model-adapter-internal.js";

export { EdenSession };

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
