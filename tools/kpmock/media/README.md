# Медиа kpmock

`sample.webm` — ролик для e2e в web-версии MSX (спец. §14.4, решение планировщика Р-9).

- **Как получен:** `npm run gen:media` (`tools/gen-media.sh`): `ffmpeg` с тестовой таблицей `testsrc` 320×180, 15 кадров/с, и синусом 440 Гц, 60 с, VP9 40 кбит/с + Opus 16 кбит/с, флаги `bitexact` (повторный запуск даёт тот же файл).
- **Почему WebM:** Chromium из Playwright не декодирует H.264/AAC, поэтому MP4 из спец. §14.2 в e2e не сыграет.
- **Где используется:** при `media: "webm"` (`startMock({ media: "webm" })`, `npm run mock -- --media webm` или сценарий `{"media":"webm"}`) все ссылки `http`, `hls`, `hls2`, `hls4` ведут на `/cdn/media/sample.webm?mid=<mid>&loc=nl`; mock отдаёт файл с поддержкой `Range`.
- **Лицензия:** полностью синтетический, без чужих материалов; передаётся в общественное достояние по [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
