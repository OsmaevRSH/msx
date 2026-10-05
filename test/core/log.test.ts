import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Logger, maskSecrets, type LogEntry } from "../../src/core/log.ts";
import { FakeClock } from "../helpers/fake-clock.ts";

describe("maskSecrets", () => {
  it("masks access_token in a query and keeps other parameters", () => {
    assert.equal(
      maskSecrets("GET https://api.example/v1/types?access_token=abc123&x=1"),
      "GET https://api.example/v1/types?access_token=***&x=1",
    );
  });

  it("masks refresh_token in JSON", () => {
    assert.equal(maskSecrets('{"refresh_token":"qwe"}'), '{"refresh_token":"***"}');
    assert.equal(maskSecrets('{"refresh_token": "qwe", "a": 1}'), '{"refresh_token": "***", "a": 1}');
  });

  it("masks user_code, code and client_secret in a query", () => {
    assert.equal(maskSecrets("user_code=ABCDEF"), "user_code=***");
    assert.equal(maskSecrets("grant_type=device_token&code=c0de9&client_id=xbmc"), "grant_type=device_token&code=***&client_id=xbmc");
    assert.equal(maskSecrets("client_id=xbmc&client_secret=s3cr3t"), "client_id=xbmc&client_secret=***");
  });

  it("masks numeric JSON values and escaped JSON inside a string", () => {
    assert.equal(maskSecrets('{"code": 123456}'), '{"code": "***"}');
    assert.equal(maskSecrets('{"body":"{\\"access_token\\":\\"zzz\\"}"}'), '{"body":"{\\"access_token\\":\\"***\\"}"}');
  });

  it("does not touch similar keys and other values", () => {
    for (const s of ["mid=123", "error_code=5", "qrcode=1", '{"error_code":"E1"}', '{"device_code_hint":"x"}', "grant_type=device_code"]) {
      assert.equal(maskSecrets(s), s);
    }
  });
});

describe("Logger", () => {
  it("records level, tag, message and time from the clock", async () => {
    const clock = new FakeClock(5_000, 0);
    const log = new Logger(clock);
    log.debug("a", "one");
    await clock.advance(10);
    log.info("b", "two", { n: 1 });
    log.warn("c", "three");
    log.error("d", "four");
    const e = log.entries();
    assert.deepEqual(
      e.map((x) => [x.t, x.level, x.tag, x.msg]),
      [
        [5_000, "debug", "a", "one"],
        [5_010, "info", "b", "two"],
        [5_010, "warn", "c", "three"],
        [5_010, "error", "d", "four"],
      ],
    );
    assert.deepEqual(e[1]?.data, { n: 1 });
    assert.equal("data" in (e[0] as LogEntry), false);
  });

  it("keeps at most 500 entries by default, evicting the oldest", () => {
    const log = new Logger(new FakeClock());
    for (let i = 0; i < 520; i++) log.info("t", `m${i}`);
    const e = log.entries();
    assert.equal(e.length, 500);
    assert.equal(e[0]?.msg, "m20");
    assert.equal(e[499]?.msg, "m519");
  });

  it("respects a custom capacity", () => {
    const log = new Logger(new FakeClock(), 3);
    for (let i = 0; i < 5; i++) log.info("t", `m${i}`);
    assert.deepEqual(log.entries().map((x) => x.msg), ["m2", "m3", "m4"]);
  });

  it("tail(n) returns the last n entries in order", () => {
    const log = new Logger(new FakeClock());
    for (let i = 0; i < 10; i++) log.info("t", `m${i}`);
    assert.deepEqual(log.tail(3).map((x) => x.msg), ["m7", "m8", "m9"]);
    assert.deepEqual(log.tail(0), []);
    assert.equal(log.tail(50).length, 10);
  });

  it("masks secrets in msg and data", () => {
    const log = new Logger(new FakeClock());
    log.info("api", "GET /v1/user?access_token=abc123 200", {
      url: "/oauth2/token?refresh_token=qwe&grant_type=refresh_token",
      refresh_token: "qwe",
      nested: { user_code: "ABCDEF", mid: 123 },
    });
    const [e] = log.entries();
    assert.equal(e?.msg, "GET /v1/user?access_token=*** 200");
    assert.deepEqual(e?.data, {
      url: "/oauth2/token?refresh_token=***&grant_type=refresh_token",
      refresh_token: "***",
      nested: { user_code: "***", mid: 123 },
    });
    assert.ok(!JSON.stringify(log.entries()).includes("abc123"));
    assert.ok(!JSON.stringify(log.entries()).includes("qwe"));
  });

  it("survives data that cannot be serialized", () => {
    const log = new Logger(new FakeClock());
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    log.warn("t", "cyclic", loop);
    assert.equal(log.entries().length, 1);
  });

  it("passes masked entries to the sink and ignores sink failures", () => {
    const log = new Logger(new FakeClock());
    const seen: LogEntry[] = [];
    log.sink = (e) => seen.push(e);
    log.info("t", "code=12345");
    assert.equal(seen[0]?.msg, "code=***");
    log.sink = () => {
      throw new Error("console is gone");
    };
    log.info("t", "still logged");
    assert.equal(log.tail(1)[0]?.msg, "still logged");
  });

  it("entries() returns a copy", () => {
    const log = new Logger(new FakeClock());
    log.info("t", "x");
    log.entries().pop();
    assert.equal(log.entries().length, 1);
  });
});
