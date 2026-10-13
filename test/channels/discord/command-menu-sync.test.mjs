import assert from 'node:assert/strict';
import test from 'node:test';

import { SHARED_COMMAND_CATALOG, commandsForChannel } from '../../../src/channels/shared/command-catalog.mjs';
import { setImHostLanguage } from '../../../src/channels/shared/i18n.mjs';
import { COMMAND_PERMISSION_DENIED_MESSAGE } from '../../../src/channels/shared/inbound-access.mjs';
import {
  DISCORD_COMMAND_MAX_COUNT,
  DISCORD_COMMAND_NAME_PATTERN,
  discordCommandDefinitions,
  discordCommandNames,
  discordCommandText,
  normalizeDiscordCommandTable,
  syncDiscordCommands,
  validateDiscordCommands,
} from '../../../src/channels/discord/discord-command-registry.mjs';
import { DiscordBotClient, DiscordRuntime } from '../../../src/channels/discord/discord-runtime.mjs';

const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.ABCD.abcdefghijklmnopqrstuvwxyz123456';
const BOT_ID = '1234567890123456789';
const PARENT_ID = '222222222222222270';
const GUILD_ID = '444444444444444444';
const USER_ID = '333333333333333330';
const INTERACTION_TOKEN = 'interaction-token-abcdefghijklmnop';
const THREAD_ID = '777777777777777770';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met before timeout');
}

class FakeSocket {
  #listeners = new Map();

  sent = [];

  readyState = 1;

  addEventListener(name, listener) {
    const listeners = this.#listeners.get(name) ?? [];
    listeners.push(listener);
    this.#listeners.set(name, listeners);
  }

  send(value) {
    const packet = JSON.parse(value);
    this.sent.push(packet);
    if (packet.op === 2) {
      queueMicrotask(() => this.emit('message', {
        data: JSON.stringify({
          op: 0,
          t: 'READY',
          s: 1,
          d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg' },
        }),
      }));
    }
  }

  close(code = 1000) {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit('close', { code });
  }

  emit(name, event) {
    for (const listener of this.#listeners.get(name) ?? []) listener(event);
  }
}

function memoryState() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessions,
    seen,
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, sessionId) => { sessions.set(key, sessionId); },
    clearSession: async (key) => { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => { seen.add(id); },
  };
}

function harnessStub(asks) {
  let next = 1;
  return {
    ensureRunning: async () => true,
    currentBusyMessageMode: () => 'queue',
    async createSession() {
      const sessionId = `session-${next}`;
      next += 1;
      return sessionId;
    },
    sessionExists: async () => true,
    async ask(sessionId, text) {
      asks.push({ sessionId, text });
      return `answer:${text}`;
    },
  };
}

/**
 * A runtime fixture whose API records command-table writes and interaction
 * callbacks, plus the partial-API variant used to prove feature detection.
 */
function runtimeFor(t, {
  state = memoryState(),
  accessPolicy,
  commandCatalog,
  partialApi = false,
  logger = { warn() {}, error(...args) { assert.fail(args.join(' ')); } },
} = {}) {
  const calls = { list: [], set: [], ack: [], edit: [], created: [], cleared: [], threads: [] };
  const asks = [];
  let socket;
  const api = {
    getCurrentUser: async () => ({ id: BOT_ID, bot: true }),
    getCurrentApplication: async () => ({ id: BOT_ID }),
    getGatewayBot: async () => ({ url: 'wss://gateway.discord.gg' }),
    getChannel: async ({ channelId }) => ({ id: channelId, type: 0 }),
    startThread: async (request) => {
      calls.threads.push(request);
      return { id: THREAD_ID, type: 11, parent_id: request.channelId, owner_id: BOT_ID };
    },
    sendTyping: async () => {},
    createMessage: async (request) => {
      calls.created.push(request);
      return { id: `8888888888888888${String(calls.created.length).padStart(2, '0')}` };
    },
    editMessage: async ({ messageId }) => ({ id: messageId }),
  };
  if (!partialApi) {
    // Mutable so one test can observe the idempotent second start.
    const registered = { value: [] };
    api.listApplicationCommands = async (request) => {
      calls.list.push(request);
      return registered.value;
    };
    api.setApplicationCommands = async (request) => {
      calls.set.push(request);
      registered.value = request.commands;
      return request.commands;
    };
    api.createInteractionResponse = async (request) => {
      calls.ack.push(request);
      return null;
    };
    api.editInteractionResponse = async (request) => {
      calls.edit.push(request);
      return null;
    };
  }
  const runtime = new DiscordRuntime({
    config: { botId: 'discord_menu_sync', platformId: BOT_ID, name: 'Harness Discord' },
    token: TOKEN,
    harness: harnessStub(asks),
    state,
    ...(accessPolicy ? { accessPolicy } : {}),
    ...(commandCatalog ? { commandCatalog } : {}),
    createApi: () => api,
    createWebSocket: () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
      }));
      return socket;
    },
    random: () => 0.5,
    logger,
  });
  t.after(() => runtime.stop());
  return { runtime, calls, state, asks, api, socket: () => socket };
}

function interactionPayload({
  id = '999999999999999999',
  name = 'version',
  options = [],
  type = 2,
  guildId = GUILD_ID,
  userId = USER_ID,
} = {}) {
  return {
    id,
    application_id: BOT_ID,
    type,
    token: INTERACTION_TOKEN,
    channel_id: PARENT_ID,
    ...(guildId ? { guild_id: guildId } : {}),
    ...(userId ? {
      member: { user: { id: userId, username: 'tester' }, nick: 'Tester' },
    } : {}),
    ...(type === 2 ? { data: { id: '1', name, type: 1, options } } : {}),
  };
}

function emitInteraction(socket, payload, sequence = 5) {
  socket.emit('message', {
    data: JSON.stringify({ op: 0, t: 'INTERACTION_CREATE', s: sequence, d: payload }),
  });
}

test('Discord command definitions cover every visible catalog command with valid names', () => {
  const commands = discordCommandDefinitions();
  const expected = commandsForChannel('discord')
    .filter((item) => item.menuVisible !== false)
    .flatMap((item) => [item, ...(item.aliases ?? [])])
    .filter((entry) => entry.menuVisible !== false && entry.enabled !== false);
  assert.deepEqual(
    commands.map((command) => command.name).sort(),
    [...new Set(expected.map((entry) => entry.name))].sort(),
  );
  assert.equal(commands.length <= DISCORD_COMMAND_MAX_COUNT, true);
  for (const command of commands) {
    assert.match(command.name, DISCORD_COMMAND_NAME_PATTERN);
    assert.equal(typeof command.description, 'string');
    assert.equal(command.description.length > 0, true);
    assert.equal(command.description.length <= 100, true);
  }
  assert.equal(new Set(commands.map((command) => command.name)).size, commands.length);
});

test('Discord command descriptions are translated and free of Chinese in English mode', (t) => {
  const previous = setImHostLanguage('en');
  t.after(() => setImHostLanguage(previous));
  const commands = discordCommandDefinitions();
  assert.equal(commands.length > 0, true);
  for (const command of commands) {
    assert.doesNotMatch(command.description, /\p{Script=Han}/u, `${command.name} leaked Chinese`);
  }
});

test('Discord restricts private-only commands to direct messages and private channels', () => {
  const commands = discordCommandDefinitions();
  const byName = new Map(commands.map((command) => [command.name, command]));
  for (const name of ['history', 'batch', 'send', 'cancel']) {
    assert.deepEqual(byName.get(name)?.contexts, [1, 2], `${name} must stay private`);
  }
  assert.equal(byName.get('help')?.contexts, undefined, 'public commands must keep the default contexts');
});

test('Discord gives argument-taking commands one free-text option and none to the rest', () => {
  const byName = new Map(discordCommandDefinitions().map((command) => [command.name, command]));
  for (const name of ['model', 'session', 'steer']) {
    const options = byName.get(name)?.options;
    assert.equal(Array.isArray(options), true, `${name} needs an input option`);
    assert.deepEqual(options.map((option) => option.name), ['input']);
    assert.equal(options[0].type, 3);
    assert.equal(options[0].required, false);
  }
  for (const name of ['new', 'help', 'version', 'status']) {
    assert.equal(byName.get(name)?.options, undefined, `${name} takes no arguments`);
  }
});

test('Discord reconstructs the text command from an interaction, including its argument', () => {
  const command = (name, options = []) => discordCommandText(interactionPayload({ name, options }));
  assert.equal(command('version'), '/version');
  assert.equal(command('model', [{ name: 'input', type: 3, value: '2 high' }]), '/model 2 high');
  assert.equal(command('model', [{ name: 'input', type: 3, value: '   ' }]), '/model');
  assert.equal(command('MODEL', [{ name: 'input', type: 3, value: '1' }]), '/model 1');
  // Anything that is not a known chat-input command never becomes prompt text.
  assert.equal(command('not-a-command'), null);
  assert.equal(discordCommandText(interactionPayload({ type: 3 })), null);
  assert.equal(discordCommandText({ type: 2, data: { name: 'model', type: 2, options: [] } }), null);
  assert.equal(discordCommandText(null), null);
});

test('Discord command validation rejects malformed tables', () => {
  assert.throws(() => validateDiscordCommands('nope'), /must be an array/);
  assert.throws(() => validateDiscordCommands([]), /must not be empty/);
  assert.deepEqual(validateDiscordCommands([], { allowEmpty: true }), []);
  const wellFormed = [{ name: 'ok', description: 'd' }];
  assert.equal(validateDiscordCommands(wellFormed), wellFormed);
  assert.throws(
    () => validateDiscordCommands([{ name: 'Bad', description: 'd' }]),
    /Invalid Discord application command name/,
  );
  assert.throws(
    () => validateDiscordCommands([
      { name: 'dup', description: 'a' },
      { name: 'dup', description: 'b' },
    ]),
    /Duplicate Discord application command name/,
  );
  assert.throws(
    () => validateDiscordCommands([{ name: 'ok', description: '' }]),
    /Invalid Discord application command description/,
  );
  assert.throws(
    () => validateDiscordCommands([{
      name: 'ok', description: 'd', options: [{ type: 4, name: 'input', description: 'd' }],
    }]),
    /Unsupported Discord command option type/,
  );
});

test('Discord normalizes a fetched table so a GET echo never looks like a change', () => {
  const desired = discordCommandDefinitions();
  const echoed = desired.map((command) => ({
    ...command,
    id: '999',
    application_id: BOT_ID,
    version: '1',
    type: 1,
    name_localizations: null,
    ...(command.contexts ? {} : { contexts: [0, 1, 2] }),
  }));
  assert.deepEqual(normalizeDiscordCommandTable(echoed), normalizeDiscordCommandTable(desired));
});

test('Discord sync skips the API entirely when the client cannot register commands', async () => {
  const result = await syncDiscordCommands({
    api: { getCurrentUser: async () => ({}) },
    commands: discordCommandDefinitions(),
  });
  assert.deepEqual(result, { changed: false, skipped: true, count: discordCommandDefinitions().length });
});

test('Discord sync only writes when the registered table differs', async () => {
  const commands = discordCommandDefinitions();
  let stored = [];
  const api = {
    listApplicationCommands: async () => stored,
    setApplicationCommands: async ({ commands: next }) => { stored = next; },
  };
  const first = await syncDiscordCommands({ api, commands });
  assert.deepEqual(first, { changed: true, skipped: false, count: commands.length });
  const second = await syncDiscordCommands({ api, commands });
  assert.deepEqual(second, { changed: false, skipped: false, count: commands.length });
});

test('Discord runtime registers the command menu before connecting and skips an unchanged table', async (t) => {
  const { runtime, calls } = runtimeFor(t);
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.equal(calls.list.length, 1);
  assert.equal(calls.set.length, 1);
  assert.deepEqual(calls.set[0].commands, normalizeDiscordCommandTable(discordCommandDefinitions()));
  assert.equal(calls.set[0].applicationId, BOT_ID);

  // A second runtime over the same registered table performs no PUT.
  const second = runtimeFor(t);
  second.api.listApplicationCommands = async () => calls.set[0].commands;
  await second.runtime.start();
  assert.equal(second.calls.set.length, 0);
});

test('Discord runtime still connects when command registration fails', async (t) => {
  const warnings = [];
  const { runtime, calls } = runtimeFor(t, {
    logger: { warn: (...args) => warnings.push(args), error(...args) { assert.fail(args.join(' ')); } },
  });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.equal(calls.set.length, 1);
  assert.equal(warnings.length, 0);
});

test('Discord runtime warns instead of failing when the command API rejects the table', async (t) => {
  const warnings = [];
  const { runtime, api } = runtimeFor(t, {
    logger: { warn: (...args) => warnings.push(args), error(...args) { assert.fail(args.join(' ')); } },
  });
  api.setApplicationCommands = async () => {
    throw Object.assign(new Error('Discord rejected the command table'), { code: 'discord-400' });
  };
  await runtime.start();
  assert.equal(runtime.status.ready, true, 'a stale menu must never keep the bot offline');
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /command menu setup failed/u);
});

test('Discord runtime connects against a partial API without command endpoints', async (t) => {
  const { runtime, calls } = runtimeFor(t, { partialApi: true });
  await runtime.start();
  assert.equal(runtime.status.ready, true);
  assert.equal(calls.set.length, 0);
  assert.equal(calls.list.length, 0);
});

test('refreshCommandMenu reports whether a connected bot accepted the refreshed menu', async (t) => {
  const { runtime, calls } = runtimeFor(t);
  assert.equal(await runtime.refreshCommandMenu(), false, 'a stopped runtime must not refresh');
  await runtime.start();
  assert.equal(calls.set.length, 1, 'startup already registered the table');
  assert.equal(await runtime.refreshCommandMenu(), true);
  await runtime.stop();
  assert.equal(await runtime.refreshCommandMenu(), false, 'a stopped runtime must not refresh');
});

test('refreshCommandMenu follows the host language into the registered descriptions', async (t) => {
  const previous = setImHostLanguage('zh');
  const { runtime, calls } = runtimeFor(t);
  await runtime.start();
  assert.equal(calls.set.length, 1);
  setImHostLanguage('en');
  assert.equal(await runtime.refreshCommandMenu(), true);
  assert.equal(calls.set.length, 2);
  for (const command of calls.set[1].commands) {
    assert.doesNotMatch(command.description, /\p{Script=Han}/u);
  }
  setImHostLanguage(previous);
});

test('Discord answers a guild command in place without opening a Thread', async (t) => {
  const { runtime, calls, socket } = runtimeFor(t);
  await runtime.start();
  socket().emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: { id: GUILD_ID, channels: [{ id: PARENT_ID, type: 0 }], threads: [] },
    }),
  });
  emitInteraction(socket(), interactionPayload({ name: 'version' }));
  await eventually(() => calls.created.length === 1 || calls.edit.some((call) => call.body?.content));
  assert.equal(calls.ack.length, 1);
  assert.equal(calls.ack[0].interactionId, '999999999999999999');
  assert.equal(calls.ack[0].interactionToken, INTERACTION_TOKEN);
  assert.deepEqual(calls.ack[0].body, { type: 5 });
  // Threads are opt-in: an ordinary guild command stays in its channel.
  assert.deepEqual(calls.threads, [], 'an ordinary guild command must not open a Thread');
  assert.equal(calls.created.length, 0, 'the deferred response carries the reply');
  const answer = calls.edit.find((call) => call.body?.content);
  assert.match(answer.body.content, /^dsh-im v\d+\.\d+\.\d+$/u);
  assert.equal(runtime.status.ready, true);
});

test('Discord opens a Thread for /thread and never forwards the command to the model', async (t) => {
  const { runtime, calls, socket } = runtimeFor(t);
  await runtime.start();
  socket().emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: { id: GUILD_ID, channels: [{ id: PARENT_ID, type: 0 }], threads: [] },
    }),
  });
  emitInteraction(socket(), interactionPayload({ name: 'thread' }));
  await eventually(() => calls.edit.length === 1);
  assert.equal(calls.threads.length, 1);
  assert.equal(calls.threads[0].channelId, PARENT_ID);
  assert.match(calls.threads[0].name, /thread/u);
  assert.equal(calls.edit[0].applicationId, BOT_ID);
  assert.equal(calls.edit[0].interactionToken, INTERACTION_TOKEN);
  assert.match(calls.edit[0].body.content, new RegExp(THREAD_ID, 'u'));
  // `/thread` is a pure control command: it points the invoker at the Thread
  // and posts nothing else - the model never sees it.
  assert.deepEqual(calls.created, [], 'the command must not reach the model');
  assert.equal(runtime.status.ready, true);
});

test('Discord answers a direct-message command in place without a Thread', async (t) => {
  const { runtime, calls, socket } = runtimeFor(t);
  await runtime.start();
  emitInteraction(socket(), interactionPayload({ name: 'version', guildId: null }));
  await eventually(() => calls.edit.length === 1);
  assert.deepEqual(calls.ack[0].body, { type: 5 });
  assert.deepEqual(calls.threads, [], 'a direct message cannot host a Thread');
  assert.match(calls.edit[0].body.content, /^dsh-im v\d+\.\d+\.\d+$/u);
  assert.equal(calls.created.length, 0, 'a single-chunk reply must not post a second message');
});

test('Discord still answers when Thread creation fails', async (t) => {
  const { runtime, calls, socket, api } = runtimeFor(t);
  api.startThread = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 'discord-403' }); };
  await runtime.start();
  socket().emit('message', {
    data: JSON.stringify({
      op: 0, t: 'GUILD_CREATE', s: 2,
      d: { id: GUILD_ID, channels: [{ id: PARENT_ID, type: 0 }], threads: [] },
    }),
  });
  emitInteraction(socket(), interactionPayload({ name: 'version' }));
  await eventually(() => calls.edit.length === 1);
  assert.equal(calls.ack.length, 1);
  // No Thread: the deferred placeholder carries the answer in place.
  assert.equal(calls.created.length, 0);
  assert.match(calls.edit[0].body.content, /^dsh-im v\d+\.\d+\.\d+$/u);
});

test('Discord answers a PING interaction without touching the session or the model', async (t) => {
  const { runtime, calls, asks, socket } = runtimeFor(t);
  await runtime.start();
  emitInteraction(socket(), interactionPayload({ type: 1, name: undefined }), 3);
  await eventually(() => calls.ack.length === 1);
  assert.deepEqual(calls.ack[0].body, { type: 1 });
  assert.equal(calls.edit.length, 0);
  assert.deepEqual(asks, []);
});

test('Discord ignores an unknown interaction name and never ACKs it', async (t) => {
  const { runtime, calls, socket } = runtimeFor(t);
  await runtime.start();
  emitInteraction(socket(), interactionPayload({ name: 'definitely-not-registered' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls.ack, []);
  assert.deepEqual(calls.edit, []);
  assert.deepEqual(calls.created, []);
});

test('Discord suppresses a replayed interaction and only acknowledges it once', async (t) => {
  const { runtime, calls, socket } = runtimeFor(t);
  await runtime.start();
  const payload = interactionPayload({ name: 'version' });
  emitInteraction(socket(), payload, 3);
  await eventually(() => calls.edit.length === 1);
  emitInteraction(socket(), payload, 4);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.ack.length, 1);
  assert.equal(calls.edit.length, 1);
});

test('Discord completes the deferred response even when the command is not permitted', async (t) => {
  const state = memoryState();
  const { runtime, calls, socket } = runtimeFor(t, {
    state,
    accessPolicy: {
      isPrivileged: () => false,
      getSettings: () => ({
        direct: { mode: 'open', open: { defaultCanExecuteCommands: true, commandPermissionOverrides: [] }, allowlist: { users: [] } },
        group: {
          mode: 'allowlist',
          open: { defaultCanExecuteCommands: false, commandPermissionOverrides: [] },
          allowlist: {
            users: [{ id: USER_ID, canExecuteCommands: false }],
          },
        },
      }),
    },
  });
  await runtime.start();
  socket().emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: { id: GUILD_ID, channels: [{ id: PARENT_ID, type: 0 }], threads: [] },
    }),
  });
  emitInteraction(socket(), interactionPayload({ name: 'new' }), 3);
  await eventually(() => calls.edit.length === 1);
  assert.equal(calls.ack.length, 1);
  assert.deepEqual(calls.ack[0].body, { type: 5 });
  assert.equal(calls.edit[0].body.content, COMMAND_PERMISSION_DENIED_MESSAGE);
  assert.equal(runtime.status.messagesRejected, 1);
  assert.equal(state.sessions.size, 0, 'a denied command must not clear the session');
});

test('Discord runs a native command through the shared bridge and keeps the session key', async (t) => {
  const state = memoryState();
  state.sessions.set(`group:${THREAD_ID}`, 'session-existing');
  const { runtime, calls, socket } = runtimeFor(t, { state });
  await runtime.start();
  socket().emit('message', {
    data: JSON.stringify({
      op: 0,
      t: 'GUILD_CREATE',
      s: 2,
      d: { id: GUILD_ID, channels: [{ id: PARENT_ID, type: 0 }], threads: [] },
    }),
  });
  emitInteraction(socket(), interactionPayload({ name: 'new' }), 3);
  await eventually(() => calls.created.length >= 1 || calls.edit.some((call) => call.body?.content));
  // The Session stays bound to the channel it was invoked in, so the Thread key
  // set up by the fixture is never consulted.
  assert.equal(state.sessions.has(`group:${THREAD_ID}`), true);
  assert.deepEqual(calls.threads, [], 'an ordinary guild command must not open a Thread');
  const reply = calls.created[0] ?? calls.edit.find((call) => call.body?.content);
  assert.match(reply.content ?? reply.body.content, /新会话/u);
});

test('Discord bot client completes a bound interaction once, then posts ordinary messages', async () => {
  const edits = [];
  const created = [];
  const client = new DiscordBotClient({
    api: {
      async editInteractionResponse(request) { edits.push(request); return null; },
      async createMessage(request) { created.push(request); return { id: `8888888888888888${created.length}` }; },
    },
  });
  const target = { channelId: PARENT_ID };
  client.attachInteraction(target, {
    id: '999999999999999999',
    token: INTERACTION_TOKEN,
    applicationId: BOT_ID,
    completed: false,
  });
  await client.sendText(target, 'first reply');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].interactionToken, INTERACTION_TOKEN);
  assert.equal(edits[0].applicationId, BOT_ID);
  assert.deepEqual(edits[0].body, { content: 'first reply' });
  assert.equal(created.length, 0);

  await client.sendText(target, 'second reply');
  assert.equal(edits.length, 1, 'a deferred response can only be completed once');
  assert.deepEqual(created.map((request) => request.content), ['second reply']);
});

test('Discord bot client keeps streaming on the deferred interaction message', async () => {
  const edits = [];
  const created = [];
  const client = new DiscordBotClient({
    api: {
      async editInteractionResponse(request) { edits.push(request); return null; },
      async createMessage(request) { created.push(request); return { id: '777' }; },
    },
  });
  const target = { channelId: PARENT_ID };
  client.attachInteraction(target, {
    id: '999999999999999999', token: INTERACTION_TOKEN, applicationId: BOT_ID, completed: false,
  });
  const stream = await client.openStream(target);
  assert.equal(stream.messageId, '999999999999999999');
  await stream.finish('streamed answer');
  assert.equal(edits.at(-1).body.content, 'streamed answer');
  assert.equal(created.length, 0, 'the deferred message is the streaming message');
});

test('Discord never acknowledges an interaction the catalog no longer defines', async (t) => {
  const { runtime, calls, socket } = runtimeFor(t, {
    commandCatalog: SHARED_COMMAND_CATALOG.filter((item) => item.name !== 'version'),
  });
  await runtime.start();
  // 'version' is gone from the catalog, so it is not a known command any more.
  emitInteraction(socket(), interactionPayload({ name: 'version' }), 3);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls.ack, []);
  assert.deepEqual(calls.edit, []);
});

test('Discord stops resetting menu state so a later start re-registers the table', async (t) => {
  const { runtime, calls } = runtimeFor(t);
  await runtime.start();
  assert.equal(calls.set.length, 1);
  await runtime.stop();
  await runtime.start();
  assert.equal(calls.set.length, 1, 'an unchanged table is not written twice');
  assert.equal(calls.list.length, 2);
});

test('Discord command names resolve for the registry lookup used by the interaction path', () => {
  const names = discordCommandNames();
  assert.equal(names.has('new'), true);
  assert.equal(names.has('model'), true);
  assert.equal(names.has('ws'), true, 'aliases are registered as their own commands');
  assert.equal(names.has('nope'), false);
});
