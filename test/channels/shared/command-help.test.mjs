import assert from 'node:assert/strict';
import test from 'node:test';

import { commandHelpLines } from '../../../src/channels/shared/command-catalog.mjs';
import { getImHostLanguage, setImHostLanguage, t as translate } from '../../../src/channels/shared/i18n.mjs';
import { DiscordHarnessBridge } from '../../../src/channels/discord/discord-bridge.mjs';
import { SlackHarnessBridge } from '../../../src/channels/slack/slack-bridge.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { WhatsappHarnessBridge } from '../../../src/channels/whatsapp/whatsapp-bridge.mjs';
import legacyHelp from './fixtures/command-help.json' with { type: 'json' };
import legacyHelpDiscord from './fixtures/command-help-discord.json' with { type: 'json' };

// `/thread` ships on Discord only, so it is spliced into that channel's expected
// help right after the `/conv` block instead of being duplicated into every
// other channel's fixture.
const expectedHelp = (channel, language) => {
  const lines = [...legacyHelp[language]];
  if (channel !== 'discord') return lines;
  const anchor = lines.findIndex((line) => line.startsWith('/conv clear'));
  lines.splice(anchor + 1, 0, ...legacyHelpDiscord[language]);
  return lines;
};

// Captured from the pre-catalog bridge in zh/en: guard the complete usage,
// ordering and examples independently of the metadata now used in production.
for (const [channel, label, Bridge] of [
  ['telegram', 'Telegram', TelegramHarnessBridge],
  ['slack', 'Slack', SlackHarnessBridge],
  ['discord', 'Discord', DiscordHarnessBridge],
  ['whatsapp', 'WhatsApp', WhatsappHarnessBridge],
]) {
  for (const language of ['zh', 'en']) {
    test(`${channel} /help preserves all legacy ${language} usage and examples`, async (t) => {
      const previous = getImHostLanguage();
      t.after(() => setImHostLanguage(previous));
      setImHostLanguage(language);
      let help;
      const bridge = new Bridge({
        bot: { sendText: async (_, text) => { help = text; } },
        harness: {},
        state: { hasSeen: () => false, markSeen: async () => {}, sessionFor: () => null },
      });
      await bridge.accept({
        messageId: 'help', senderId: '42', kind: 'direct', conversationId: '88',
        content: '/help', replyTarget: {},
      });
      assert.equal(help, [
        translate('{label}机器人已连接 DeepSeek Harness。', { label }),
        '',
        translate('直接发送文字、图片或文件即可继续当前会话。'),
        ...expectedHelp(channel, language),
      ].join('\n'));
      assert.deepEqual(commandHelpLines(channel), expectedHelp(channel, language));
    });
  }
}
