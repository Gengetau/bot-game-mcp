/* 附近聊天（页签「附近」）：C1a 的示范模块。消息列表和输入栏在 00-chatkit.js；这里只把 Godot 的 feed 接给它。
 * feed 的 kind：state（可发 / 不可发的原因、字数上限、附近有没有人、地点）、append（新消息，items 带 id 去重）、ack（一次发送的回应）、reset（离开 / 换人）。
 * 文字都在 nearby.html 的模板里（host.t 读文字库），这个文件里没有汉字字面量（lint 检查）。 */
(function () {
  'use strict';
  window.TownDock.register({
    id: 'nearby',
    api: 1,
    mount: function (host) {
      var kit = window.TownChatKit.create(host, { msgTpl: 'tpl-nearby-msg' });
      return {
        onFeed: function (kind, data) {
          if (kind === 'state') kit.setState(data);
          else if (kind === 'append') kit.append(data && data.items, !!(data && data.live));
          else if (kind === 'ack') kit.onAck(data);
          else if (kind === 'reset') kit.reset();
        },
        onCore: function () {},
        onShow: function () {
          kit.onShow();
        },
        onHide: function () {},
        forceSend: function (text) {
          kit.forceSend(text);
        },
        debug: function () {
          return kit.debug();
        },
      };
    },
  });
})();
