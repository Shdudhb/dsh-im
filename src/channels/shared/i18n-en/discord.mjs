// English translations (discord area). Keys are exact Chinese literals passed to t().
export default {
  'Discord Bot Token 无效，请重新填写。': 'The Discord Bot Token is invalid. Please enter it again.',
  'Discord Gateway Intents 配置不正确，请检查 Developer Portal 的 Bot 设置。':
    'The Discord Gateway Intents are misconfigured. Please check the Bot settings in the Developer Portal.',
  'Discord机器人': 'Discord Bot',
  ' Gateway 长连接': ' Gateway long-lived connection',
  'Thread 创建结果暂时无法确认。若已创建，请在对应 Thread 中重试；若未创建，请稍后重新 @机器人。':
    'The Thread creation result cannot be confirmed yet. If the Thread was created, retry inside it; if it was not, mention the bot again shortly.',
  '命令参数，用法与对应的文本命令一致': 'Command arguments, used exactly like the matching text command',
  '已创建讨论串，请在讨论串中继续本次会话：{thread}':
    'Thread created. Continue this session inside {thread}.',
  '无法创建 Thread，请在当前频道重新发送你的问题。':
    'The Thread could not be created. Please resend your question in this channel.',
  '当前频道不支持创建 Thread，已直接在当前频道回复。':
    'This channel cannot host a Thread, so the reply was posted here instead.',
  '无法创建 Thread，已直接在当前频道回复。':
    'The Thread could not be created, so the reply was posted here instead.',
  '在频道中创建讨论串，随后在讨论串中提问（仅 Discord）':
    'Create a Thread in a channel, then ask your question inside it (Discord only)',
  '/thread [名称]  在当前频道创建一个讨论串（未填名称时自动命名）':
    '/thread [name]  Create a Thread in the current channel (auto-named when omitted)',
  '创建后本指令不再回复，请在讨论串中重新发送你的问题':
    'This command sends no reply of its own - resend your question inside the Thread',
  '关闭讨论串并结束当前会话': 'Close a Thread and end the current session',
  '/close  删除当前讨论串并结束会话绑定（仅 Discord）':
    '/close  Delete the current Thread and release the session binding (Discord only)',
  '在普通频道中执行时只结束会话绑定，不会删除频道':
    'Run in a normal channel it only ends the session binding; the channel is left alone',
  '当前不在讨论串中，已结束本次会话。请发送新消息重新开始。':
    'This is not a Thread, so the session was ended. Send a new message to start again.',
  '已结束本次会话。请发送新消息重新开始。':
    'The session was ended. Send a new message to start again.',
};
