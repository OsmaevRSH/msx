import { parseArgs } from "node:util";
import { startMock } from "./server.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    media: { type: "string", default: "playlist" },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`kpmock: bad --port ${values.port}`);
  process.exit(2);
}
if (values.media !== "playlist" && values.media !== "webm") {
  console.error(`kpmock: --media must be playlist or webm, got ${values.media}`);
  process.exit(2);
}

const mock = await startMock({ port, host: values.host, media: values.media });
console.log(`kpmock listening on ${mock.url} (media: ${values.media})`);

let closing = false;
const stop = (): void => {
  if (closing) return;
  closing = true;
  mock.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
