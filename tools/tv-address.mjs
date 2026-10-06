// Что вводить на ТВ в Start Parameter MSX (спец. §15.2, §15.7, CM-04): `npm run tv-address -- <login> [repo]`.

const DEFAULT_REPO = "msx";
/** Логин GitHub: буквы, цифры и одиночные дефисы не по краям, до 39 символов. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]+$/;
const ALIAS_INPUT = "id:igd:<alias>";
const USAGE = "usage: npm run tv-address -- <login> [repo]";

const aliasSteps = (target) => [
  `на https://is.gd создать короткую ссылку на ${target} с собственным алиасом только из [0-9a-z]`,
  `на ТВ ввести ${ALIAS_INPUT} (вместо <alias> — свой алиас)`,
  "при необходимости добавить is.gd в podkop",
];

// Экранный ввод MSX: цифры и строчные буквы, дефис — маркер заглавной буквы (`eXaMpLe` вводится как `e-xa-mp-le`).
const hyphenWarning = (input, target) =>
  `В логине есть дефис: при вводе с пульта дефис превращает следующую букву в заглавную. ` +
  `Сначала введите ${input} и сверьте строку на экране буква в букву. Если не совпала — ${aliasSteps(target).join("; ")}.`;

/**
 * @param {string} login
 * @param {string} [repo]
 * @returns {import("./tv-address.d.mts").TvAddress}
 */
export function tvAddress(login, repo = DEFAULT_REPO) {
  if (typeof login !== "string" || !LOGIN.test(login)) throw new Error(`bad GitHub login: ${JSON.stringify(login)}`);
  if (typeof repo !== "string" || !REPO.test(repo) || repo === "." || repo === "..") {
    throw new Error(`bad repo name: ${JSON.stringify(repo)}`);
  }
  const host = `${login.toLowerCase()}.github.io`;
  // MSX ищет start parameter только по https://{SERVER}/msx/start.json. Его отдают проект-сайт `msx` и сайт
  // пользователя `<login>.github.io` (сборка с BASE_PATH=/ кладёт копию в msx/start.json, Р-4).
  if (repo === DEFAULT_REPO || repo.toLowerCase() === host) {
    const url = `https://${host}/msx/start.json`;
    const warnings = login.includes("-") ? [hyphenWarning(host, url)] : [];
    return { variant: "A", input: host, startJsonUrl: url, aliasTarget: url, warnings };
  }
  const url = `https://${host}/${repo}/msx/start.json`;
  return { variant: "B", input: ALIAS_INPUT, startJsonUrl: url, aliasTarget: url, warnings: [] };
}

/**
 * @param {import("./tv-address.d.mts").TvAddress} r
 * @returns {string}
 */
export function formatTvAddress(r) {
  const lines = ["Media Station X → Settings → Start Parameter → Setup:"];
  if (r.variant === "A") {
    lines.push(`  ввести ${r.input} и включить замок (https)`);
  } else {
    lines.push(`  ввести ${r.input}: репозиторий не «msx», а MSX ищет start.json только по адресу https://<хост>/msx/start.json`);
  }
  lines.push("  MSX покажет «KinoPub MSX» → подтвердить.", "");
  lines.push(`Проверка: в браузере открывается ${r.startJsonUrl}`, "");
  if (r.variant === "A") lines.push("Запасной путь, если адрес не вводится или не открывается на ТВ:");
  else lines.push("Короткая ссылка:");
  aliasSteps(r.aliasTarget).forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  for (const w of r.warnings) lines.push("", `Внимание. ${w}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const [login, repo] = process.argv.slice(2);
  if (!login) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    try {
      console.log(formatTvAddress(tvAddress(login, repo)));
    } catch (e) {
      console.error(`${e instanceof Error ? e.message : e}\n${USAGE}`);
      process.exitCode = 2;
    }
  }
}
