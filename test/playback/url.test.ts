import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FileInfo } from "../../src/api/models.ts";
import { qualityLabel, qualityOf, withAudio, withLoc } from "../../src/playback/url.ts";

const CDN = "https://0c1e.ams-static-14.cdntogo.net/hls/TOKEN/2/46/DBCtPgEVqLdlY5qQ5.mp4";

function file(over: Partial<FileInfo>): FileInfo {
  return { codec: "h264", w: 1920, h: 1080, quality: "1080p", qualityId: 3, file: "/2/46/x.mp4", urls: {}, ...over };
}

describe("withAudio", () => {
  it("replaces a1 with the audio index and keeps the query", () => {
    assert.equal(withAudio(`${CDN}/master-v1a1.m3u8?loc=nl`, 5), `${CDN}/master-v1a5.m3u8?loc=nl`);
  });

  it("works without a query", () => {
    assert.equal(withAudio(`${CDN}/master-v1a1.m3u8`, 5), `${CDN}/master-v1a5.m3u8`);
  });

  it("replaces an already substituted index", () => {
    assert.equal(withAudio(`${CDN}/master-v1a3.m3u8?loc=nl&x=1`, 5), `${CDN}/master-v1a5.m3u8?loc=nl&x=1`);
    assert.equal(withAudio(`${CDN}/master-v1a12.m3u8`, 2), `${CDN}/master-v1a2.m3u8`);
  });

  it("leaves URLs without master-v1a unchanged", () => {
    const hls2 = "https://api.service-kp.com/hls2/TOKEN/82468.m3u8?loc=nl";
    assert.equal(withAudio(hls2, 5), hls2);
    assert.equal(withAudio(`${CDN}/index-v1a1.m3u8?loc=nl`, 5), `${CDN}/index-v1a1.m3u8?loc=nl`);
  });

  it("does not touch the query or fragment", () => {
    const url = `${CDN}/master-v1a1.m3u8?next=master-v1a1.m3u8#master-v1a1.m3u8`;
    assert.equal(withAudio(url, 4), `${CDN}/master-v1a4.m3u8?next=master-v1a1.m3u8#master-v1a1.m3u8`);
  });

  it("ignores an invalid index", () => {
    const url = `${CDN}/master-v1a1.m3u8?loc=nl`;
    for (const bad of [0, -1, 1.5, Number.NaN]) assert.equal(withAudio(url, bad), url, String(bad));
  });
});

describe("withLoc", () => {
  it("adds loc to a URL without a query", () => {
    assert.equal(withLoc(`${CDN}/master-v1a1.m3u8`, "nl"), `${CDN}/master-v1a1.m3u8?loc=nl`);
  });

  it("adds loc after other parameters", () => {
    assert.equal(withLoc(`${CDN}/master-v1a1.m3u8?a=1&b=2`, "de"), `${CDN}/master-v1a1.m3u8?a=1&b=2&loc=de`);
  });

  it("replaces loc=nl with loc=ru and keeps other parameters and their encoding", () => {
    assert.equal(withLoc(`${CDN}/master-v1a1.m3u8?a=x%20y&loc=nl&b=2`, "ru"), `${CDN}/master-v1a1.m3u8?a=x%20y&loc=ru&b=2`);
  });

  it("collapses duplicate loc parameters into one", () => {
    assert.equal(withLoc(`${CDN}/m.m3u8?loc=nl&a=1&loc=de`, "ru"), `${CDN}/m.m3u8?loc=ru&a=1`);
  });

  it("keeps the fragment", () => {
    assert.equal(withLoc(`${CDN}/m.m3u8?loc=nl#t`, "ru"), `${CDN}/m.m3u8?loc=ru#t`);
    assert.equal(withLoc(`${CDN}/m.m3u8#t`, "ru"), `${CDN}/m.m3u8?loc=ru#t`);
  });

  it("does not treat parameters ending with loc as loc", () => {
    assert.equal(withLoc(`${CDN}/m.m3u8?xloc=nl`, "ru"), `${CDN}/m.m3u8?xloc=nl&loc=ru`);
  });

  it("returns the URL unchanged for an empty loc", () => {
    const url = `${CDN}/master-v1a1.m3u8?loc=nl`;
    assert.equal(withLoc(url, undefined), url);
    assert.equal(withLoc(url, ""), url);
  });

  it("encodes the loc value", () => {
    assert.equal(withLoc(`${CDN}/m.m3u8`, "a b&c"), `${CDN}/m.m3u8?loc=a%20b%26c`);
  });
});

describe("qualityOf", () => {
  it("maps quality_id 1..4", () => {
    assert.equal(qualityOf(file({ qualityId: 1, w: 0, h: 0 })), 480);
    assert.equal(qualityOf(file({ qualityId: 2, w: 0, h: 0 })), 720);
    assert.equal(qualityOf(file({ qualityId: 3, w: 0, h: 0 })), 1080);
    assert.equal(qualityOf(file({ qualityId: 4, w: 0, h: 0 })), 2160);
  });

  it("treats anamorphic 1920x800 with quality_id 3 as 1080", () => {
    assert.equal(qualityOf(file({ qualityId: 3, w: 1920, h: 800 })), 1080);
  });

  it("falls back to width when quality_id is unknown", () => {
    assert.equal(qualityOf(file({ qualityId: 0, w: 3840, h: 1600 })), 2160);
    assert.equal(qualityOf(file({ qualityId: 0, w: 3800, h: 2160 })), 2160);
    assert.equal(qualityOf(file({ qualityId: 0, w: 1920, h: 800 })), 1080);
    assert.equal(qualityOf(file({ qualityId: 9, w: 1900, h: 1072 })), 1080);
    assert.equal(qualityOf(file({ qualityId: 0, w: 1280, h: 534 })), 720);
    assert.equal(qualityOf(file({ qualityId: 0, w: 1260, h: 720 })), 720);
    assert.equal(qualityOf(file({ qualityId: 0, w: 1259, h: 720 })), 480);
    assert.equal(qualityOf(file({ qualityId: 0, w: 0, h: 0 })), 480);
  });
});

describe("qualityLabel", () => {
  it("formats the quality as <n>p", () => {
    assert.equal(qualityLabel(file({ qualityId: 3 })), "1080p");
    assert.equal(qualityLabel(file({ qualityId: 1 })), "480p");
    assert.equal(qualityLabel(file({ qualityId: 4 })), "2160p");
  });
});
