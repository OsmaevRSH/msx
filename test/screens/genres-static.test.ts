import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { STATIC_MOVIE_GENRES, staticGenres } from "../../src/screens/genres-static.ts";

describe("genres-static (research kinopub-api §6.4)", () => {
  it("has the 30 movie genres with unique ids, «Мультфильм» is 23", () => {
    assert.equal(STATIC_MOVIE_GENRES.length, 30);
    assert.equal(new Set(STATIC_MOVIE_GENRES.map((g) => g.id)).size, 30);
    assert.deepEqual(STATIC_MOVIE_GENRES.find((g) => g.id === 23), { id: 23, title: "Мультфильм" });
    assert.deepEqual(STATIC_MOVIE_GENRES.find((g) => g.id === 9), { id: 9, title: "Драма" });
  });

  it("is sorted by title", () => {
    const titles = STATIC_MOVIE_GENRES.map((g) => g.title);
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, "ru")));
  });

  it("serves movies, serials, 3D and the whole catalog; the first type of a list decides", () => {
    for (const type of ["movie", "serial", "3D", "", "movie,serial"]) assert.equal(staticGenres(type).length, 30, type);
  });

  it("has nothing for documentaries, TV shows and concerts — their genres differ", () => {
    for (const type of ["documovie", "docuserial", "documovie,docuserial", "tvshow", "concert"]) {
      assert.deepEqual(staticGenres(type), [], type);
    }
  });

  it("returns copies: the caller cannot spoil the list", () => {
    const a = staticGenres("movie");
    a[0].title = "x";
    a.pop();
    assert.equal(staticGenres("movie").length, 30);
    assert.notEqual(staticGenres("movie")[0].title, "x");
  });
});
