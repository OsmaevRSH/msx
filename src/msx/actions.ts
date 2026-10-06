// Единственное место сборки строк действий MSX. P — полный адрес плагина (спец. §6.2, CD-16).

export function req(P: string, dataId: string): string {
  return `request:interaction:${dataId}@${P}`;
}

export function contentAction(P: string, dataId: string): string {
  return `content:${req(P, dataId)}`;
}

export function panelAction(P: string, dataId: string): string {
  return `panel:${req(P, dataId)}`;
}

export function resolveAction(P: string, dataId: string): string {
  return `video:resolve:${req(P, dataId)}`;
}

export function replaceContent(flag: string, P: string, dataId: string): string {
  return `replace:content:${flag}:${req(P, dataId)}`;
}

export function replacePanel(flag: string, P: string, dataId: string): string {
  return `replace:panel:${flag}:${req(P, dataId)}`;
}

/** Меню из start parameter MSX перезагружает только так: `reload:menu` для него ничего не делает (KB actions-reference). */
export function replaceMenu(flag: string, P: string, dataId: string): string {
  return `replace:menu:${flag}:${req(P, dataId)}`;
}

export function commitMsg(msg: string): string {
  return `interaction:commit:message:${msg}`;
}

/** Сообщение плееру: динамические свойства воспроизведения, например субтитры AVPlay (Plan B §5.10). */
export function playerMsg(msg: string): string {
  return `player:commit:message:${msg}`;
}

/** "[a|b]"; "[]" — пустое действие MSX. Вложенные цепочки и литеральный "|" MSX не разбирает. */
export function chain(actions: string[]): string {
  for (const a of actions) {
    if (/[|[\]]/.test(a)) throw new Error(`chain: action must not contain "|", "[" or "]": ${a}`);
  }
  return `[${actions.join("|")}]`;
}
