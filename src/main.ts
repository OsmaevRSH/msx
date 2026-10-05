import * as tvx from "../vendor/tvx-plugin-module.min.js";

// Временная заглушка до этапа 16: меню с одним пунктом и пустой страницей.
const BUILD_PAGE = {
  headline: "KinoPub MSX",
  pages: [{ items: [{ type: "space", layout: "0,0,12,1", text: "Сборка в разработке" }] }],
};

const MENU = {
  headline: "KinoPub MSX",
  menu: [{ label: "Сборка в разработке", data: BUILD_PAGE }],
};

class StubHandler implements tvx.TVXInteractionPluginHandler {
  handleRequest(dataId: string, _data: tvx.AnyObject, callback: (respData?: tvx.AnyObject) => void): void {
    callback(dataId === "init" ? MENU : undefined);
  }
}

tvx.PluginTools.onReady(() => {
  tvx.InteractionPlugin.setupHandler(new StubHandler());
  tvx.InteractionPlugin.init();
});
