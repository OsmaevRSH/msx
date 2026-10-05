# vendor/

Библиотека TVX автора Media Station X, встраивается в бандл `app.js` без изменений.

| Поле | Значение |
|---|---|
| Версия | TVX Plugin v0.0.79 (Module); типы — `v0.0.79.1` |
| Автор | Benjamin Zachey |
| Лицензия | GPL-3.0-or-later |
| Репозиторий | https://github.com/benzac-de/msx-interaction-plugin-examples |
| Путь | `src/scripts/lib/` |
| Коммит | `4933e0b6c983949cf8e904933c63986609b9ec82` (2026-09-28) |

| Файл | SHA-256 |
|---|---|
| `tvx-plugin-module.min.js` | `978af3ec949cf575976a2b0eeafcebf78994dbbfbff0964d9ba1664336003322` |
| `tvx-plugin-module.min.d.ts` | `feffffd2ae3687362d172efe6f3a873730ca4ab9b37bdf233a8e3bb4f0f26546` |

Файлы не изменялись; обновление — отдельным коммитом с новым хешем.

`vendor/package.json` (`"type": "commonjs"`) — наш файл, не часть библиотеки. Библиотека — UMD-обёртка; без него корневой `"type": "module"` заставляет esbuild считать её ES-модулем без экспортов, и `tvx.PluginTools` в бандле становится `undefined`.
