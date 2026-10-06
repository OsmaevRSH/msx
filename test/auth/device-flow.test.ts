import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { DeviceFlow } from "../../src/auth/device-flow.ts";
import type { LoginState } from "../../src/auth/device-flow.ts";
import type { StoredPair } from "../../src/auth/tokens.ts";
import { q } from "../api/kpapi-rig.ts";
import { VERSION, useAuthMock } from "./auth-rig.ts";
import type { AuthEnv, AuthRig } from "./auth-rig.ts";

// Вход по коду (спец. §7.1, CC-02): опрос по FakeClock, slow_down, новый код, запись пары до device/notify.

interface FlowRig extends AuthRig {
  flow: DeviceFlow;
  states: LoginState[];
  /** `clock.now()` в момент каждого опроса `deviceToken`. */
  polls: number[];
  atNotify: { pair: StoredPair | undefined; writes: string[]; notifyCalls: number } | undefined;
  /** Ждёт ближайший `onChange` с нужной фазой (поддельное время идёт). */
  next(phase: LoginState["phase"], maxMs?: number): Promise<LoginState>;
}

function flowRig(env: AuthEnv, deviceTitle: () => Promise<string> = async () => "MSX UE55"): FlowRig {
  const r = env.authRig();
  const polls: number[] = [];
  const states: LoginState[] = [];
  const waiters: { phase: LoginState["phase"]; resolve: (s: LoginState) => void }[] = [];
  const fr: FlowRig = {
    ...r, polls, states, atNotify: undefined,
    flow: new DeviceFlow({
      api: r.api, auth: r.auth, clock: r.clock, log: r.log, deviceTitle,
      onChange: (s) => {
        states.push(s);
        for (const w of waiters.splice(0)) {
          if (w.phase === s.phase) w.resolve(s);
          else waiters.push(w);
        }
      },
    }),
    next: (phase, maxMs) => r.clock.runUntilSettled(new Promise<LoginState>((resolve) => waiters.push({ phase, resolve })), maxMs),
  };
  // Обёртки-шпионы над api: время опросов и состояние хранилища в момент device/notify.
  const deviceToken = r.api.deviceToken.bind(r.api);
  r.api.deviceToken = (code) => {
    polls.push(r.clock.now());
    return deviceToken(code);
  };
  const deviceNotify = r.api.deviceNotify.bind(r.api);
  r.api.deviceNotify = (title, hardware, software) => {
    fr.atNotify = { pair: r.tokens.pair(), writes: [...r.mem.writes], notifyCalls: env.calls("/v1/device/notify").length };
    return deviceNotify(title, hardware, software);
  };
  return fr;
}

const gaps = (ts: number[], from: number): number[] => ts.map((t, i) => t - (i === 0 ? from : (ts[i - 1] as number)));
const grants = (env: AuthEnv, grant: string): number => env.calls("/oauth2/device").filter((c) => q(c).get("grant_type") === grant).length;

describe("DeviceFlow (spec §7.1, CC-02)", () => {
  const env = useAuthMock();

  it("CC-02: three pending, then done; ≥ 5 s between polls; the pair is stored before device/notify", async () => {
    env.mock().setScenario({ pendingPolls: 3 });
    const r = flowRig(env);
    const st = await r.run(r.flow.start());
    const t0 = r.clock.now();
    assert.equal(st.phase, "code");
    assert.ok(st.phase === "code" && /^[A-Z]{6}$/.test(st.userCode) && st.verificationUri === "https://kino.watch/device");
    assert.ok(st.phase === "code" && st.expiresAt === t0 + 600_000);
    assert.deepEqual(r.flow.state(), st);

    await r.next("done");
    assert.deepEqual(r.flow.state(), { phase: "done" });
    const polls = env.calls("/oauth2/device").slice(1);
    assert.deepEqual(polls.map((c) => c.status), [400, 400, 400, 200]);
    assert.equal(r.polls.length, 4);
    assert.deepEqual(gaps(r.polls, t0), [5000, 5000, 5000, 5000]);

    assert.ok(r.atNotify, "device/notify was called");
    assert.ok(r.atNotify.pair, "tokens.pair() is defined when device/notify is called");
    assert.ok(r.atNotify.writes.includes("kp.auth.pair"), "kp.auth.pair is written before device/notify");
    assert.equal(r.atNotify.notifyCalls, 0, "no /v1/device/notify in the mock log before the pair is written");
    assert.equal(env.calls("/v1/device/notify").length, 1);
    assert.equal(r.auth.isLoggedIn(), true);
    assert.deepEqual(r.states, [{ phase: "done" }]);

    const dev = r.tokens.device();
    assert.equal(dev.notifiedVersion, VERSION);
    const mockDev = env.mock().state.devices.get(dev.id ?? -1);
    assert.equal(mockDev?.title, "MSX UE55");
    assert.equal(mockDev?.settings.supportHevc, 0);
    assert.equal(mockDev?.settings.mixedPlaylist, 1);

    assert.equal(r.clock.pending(), 0, "no more polls after done");
    await r.clock.advance(60_000);
    assert.equal(env.calls("/oauth2/device").length, 5);
  });

  it("slow_down at poll 1 → the next interval is 10 s and stays so", async () => {
    env.mock().setScenario({ slowDownAtPoll: 1 });
    const r = flowRig(env);
    await r.run(r.flow.start());
    const t0 = r.clock.now();
    await r.next("done");
    assert.deepEqual(gaps(r.polls, t0), [5000, 10_000, 10_000]);
  });

  it("code_expired at poll 2 → a new code is requested and onChange gets the new userCode", async () => {
    env.mock().setScenario({ codeExpiredAtPoll: 2 });
    const r = flowRig(env);
    const first = await r.run(r.flow.start());
    const renewed = await r.next("code");
    assert.ok(first.phase === "code" && renewed.phase === "code");
    assert.notEqual(renewed.userCode, first.userCode);
    assert.equal(grants(env, "device_code"), 2);
    assert.deepEqual(r.flow.state(), renewed);

    env.mock().setScenario({ codeExpiredAtPoll: undefined });
    await r.next("done");
    const codes = env.calls("/oauth2/device").filter((c) => q(c).get("grant_type") === "device_token").map((c) => q(c).get("code"));
    assert.equal(codes.length, 5, "2 polls of the old code, then 3 of the new one (pendingPolls 2)");
    assert.equal(new Set(codes.slice(0, 2)).size, 1);
    assert.deepEqual(new Set(codes.slice(2)), new Set([codes[2]]));
    assert.notEqual(codes[2], codes[0], "only the new code is polled after the renewal");
  });

  it("the code lifetime (expires_in) runs out → a new code without polling the old one", async () => {
    env.mock().setScenario({ pendingPolls: 1_000 });
    const r = flowRig(env);
    await r.run(r.flow.start());
    const t0 = r.clock.now();
    const renewed = await r.next("code", 700_000);
    assert.equal(r.clock.now() - t0, 600_000);
    assert.equal(r.polls.length, 119);
    assert.ok(renewed.phase === "code" && renewed.expiresAt === t0 + 1_200_000);
    assert.equal(grants(env, "device_code"), 2);
    r.flow.stop();
  });

  it("a network error while polling → the next poll on schedule", async () => {
    const r = flowRig(env);
    await r.run(r.flow.start());
    const t0 = r.clock.now();
    env.mock().setScenario({ rules: [{ path: "^/oauth2/device$", drop: true, times: 1 }] });
    await r.next("done");
    assert.deepEqual(env.calls("/oauth2/device").slice(1).map((c) => c.status), [0, 400, 400, 200]);
    assert.deepEqual(gaps(r.polls, t0), [5000, 5000, 5000, 5000]);
  });

  it("deviceCode failure → error state", async () => {
    env.mock().setScenario({ rules: [{ path: "^/oauth2/device$", status: 500 }] });
    const r = flowRig(env);
    assert.deepEqual(await r.run(r.flow.start()), { phase: "error", code: "KP-5XX" });
    assert.equal(env.calls("/oauth2/device").length, 1, "OAuth is not retried automatically");
    assert.equal(r.clock.pending(), 0);
  });

  // Этап 33b: блокировка по SNI или упавший VPN — запрос кода висит; экран входа не ждёт таймаут OAuth (15 с).
  it("the code request hangs → error KP-NET after 6 s (returned by start(), not announced); OAuth is not repeated", async () => {
    env.mock().setScenario({ rules: [{ path: "^/oauth2/device$", hang: true }] });
    const r = flowRig(env);
    const t0 = r.clock.perf();
    assert.deepEqual(await r.run(r.flow.start()), { phase: "error", code: "KP-NET" });
    assert.equal(r.clock.perf() - t0, 6000);
    await r.clock.advance(60_000);
    assert.equal(env.calls("/oauth2/device").length, 1, "OAuth is not retried automatically");
    assert.deepEqual(r.states, [], "the request timing out later at 15 s changes nothing");
    assert.deepEqual(r.flow.state(), { phase: "error", code: "KP-NET" });
    assert.equal(r.clock.pending(), 0);
  });

  it("a code that arrives after the 6 s verdict is taken: announced, then polling as usual (slow but alive network)", async () => {
    env.mock().setScenario({ rules: [{ path: "^/oauth2/device$", hang: true, times: 1 }] });
    const r = flowRig(env);
    assert.deepEqual(await r.run(r.flow.start()), { phase: "error", code: "KP-NET" });
    env.mock().release();
    const late = await r.next("code");
    assert.ok(late.phase === "code" && late.userCode !== "");
    assert.deepEqual(r.flow.state(), late);
    await r.next("done");
    assert.ok(r.auth.isLoggedIn());
    assert.equal(grants(env, "device_code"), 1);
  });

  it("a late code is dropped once a new start() took over", async () => {
    env.mock().setScenario({ rules: [{ path: "^/oauth2/device$", hang: true, times: 1 }] });
    const r = flowRig(env);
    assert.equal((await r.run(r.flow.start())).phase, "error");
    const again = await r.run(r.flow.start());
    assert.equal(again.phase, "code");
    env.mock().release();
    const codes = (): number => r.log.entries().filter((e) => e.tag === "api" && /^POST \/oauth2\/device 200 /.test(e.msg)).length;
    for (let i = 0; i < 300 && codes() < 2; i++) await realSleep(10);
    assert.equal(codes(), 2, "the first request got its answer");
    await realSleep(20);
    assert.deepEqual(r.flow.state(), again);
    assert.deepEqual(r.states, []);
    r.flow.stop();
  });

  it("a terminal denial → error KP-AUTH announced, polling stops", async () => {
    const r = flowRig(env);
    await r.run(r.flow.start());
    env.mock().setScenario({ rules: [{ path: "^/oauth2/device$", status: 400, times: 1 }] });
    assert.deepEqual(await r.next("error"), { phase: "error", code: "KP-AUTH" });
    assert.equal(r.clock.pending(), 0);
    assert.equal(r.auth.isLoggedIn(), false);
  });

  it("renew() → a new code via onChange; only one poll timer stays", async () => {
    const r = flowRig(env);
    const first = await r.run(r.flow.start());
    const renewed = await r.run(r.flow.renew());
    assert.ok(first.phase === "code" && renewed.phase === "code" && renewed.userCode !== first.userCode);
    assert.deepEqual(r.states, [renewed]);
    assert.equal(r.clock.pending(), 1);
    r.flow.stop();
  });

  it("stop() → no more polls; start() again gets a fresh code", async () => {
    const r = flowRig(env);
    const first = await r.run(r.flow.start());
    r.flow.stop();
    assert.deepEqual(r.flow.state(), { phase: "idle" });
    assert.equal(r.clock.pending(), 0);
    await r.clock.advance(60_000);
    assert.equal(r.polls.length, 0);
    const again = await r.run(r.flow.start());
    assert.ok(first.phase === "code" && again.phase === "code" && again.userCode !== first.userCode);
    r.flow.stop();
  });

  it("start() while a code is shown returns the same state without a new request", async () => {
    const r = flowRig(env);
    const [a, b] = await r.run(Promise.all([r.flow.start(), r.flow.start()]));
    assert.deepEqual(a, b);
    assert.deepEqual(await r.run(r.flow.start()), a);
    assert.equal(grants(env, "device_code"), 1);
    r.flow.stop();
  });

  it("a hanging deviceTitle does not hold back the pair: kp.auth.pair is written at once (spec §7.1 p. 4)", async () => {
    const r = flowRig(env, () => new Promise<string>(() => undefined));
    const save = r.tokens.save.bind(r.tokens);
    const saved = new Promise<void>((resolve) => {
      r.tokens.save = (raw) => {
        const p = save(raw);
        resolve();
        return p;
      };
    });
    await r.run(r.flow.start());
    await r.run(saved);
    assert.ok(r.mem.writes.includes("kp.auth.pair"));
    assert.deepEqual([r.auth.isLoggedIn(), r.tokens.device(), env.calls("/v1/device/notify").length], [true, {}, 0]);
    r.flow.stop();
  });

  it("deviceTitle failure → the login still completes with a fallback title", async () => {
    const r = flowRig(env, () => Promise.reject(new Error("no info")));
    await r.run(r.flow.start());
    await r.next("done");
    assert.equal(r.tokens.device().title, "MSX TV");
    assert.equal(env.mock().state.devices.get(r.tokens.device().id ?? -1)?.title, "MSX TV");
  });
});
