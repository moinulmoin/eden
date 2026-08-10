import { EdenSession } from "./session.js";

export { EdenSession };

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
