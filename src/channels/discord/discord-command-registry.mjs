import { SHARED_COMMAND_CATALOG, commandsForChannel } from '../shared/command-catalog.mjs';
import { t } from '../shared/i18n.mjs';

// Discord application-command names are lowercase and limited to 32 characters.
export const DISCORD_COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const DISCORD_COMMAND_DESCRIPTION_MAX_LENGTH = 100;
export const DISCORD_COMMAND_MAX_COUNT = 100;

// Every argument-taking text command gets one free-text option instead of typed
// named options. The option value is re-assembled into `/<name> <value>`, so the
// existing text parser stays the single source of truth for argument semantics.
export const DISCORD_COMMAND_INPUT_OPTION = 'input';
export const DISCORD_COMMAND_INPUT_MAX_LENGTH = 1_000;
export const DISCORD_COMMAND_TEXT_OPTION_TYPE = 3;
export const DISCORD_COMMAND_SUB_COMMAND_TYPE = 1;
export const DISCORD_COMMAND_CHAT_INPUT_TYPE = 1;
export const DISCORD_PING_INTERACTION_TYPE = 1;
export const DISCORD_APPLICATION_COMMAND_INTERACTION_TYPE = 2;

// Interaction contexts. Omitting `contexts` means "every context"; private-only
// commands are restricted to DMs and private channels to mirror their text rule.
export const DISCORD_CONTEXT_GUILD = 0;
export const DISCORD_CONTEXT_BOT_DM = 1;
export const DISCORD_CONTEXT_PRIVATE_CHANNEL = 2;
const DISCORD_DEFAULT_CONTEXTS = Object.freeze([
  DISCORD_CONTEXT_GUILD,
  DISCORD_CONTEXT_BOT_DM,
  DISCORD_CONTEXT_PRIVATE_CHANNEL,
]);
const DISCORD_PRIVATE_CONTEXTS = Object.freeze([
  DISCORD_CONTEXT_BOT_DM,
  DISCORD_CONTEXT_PRIVATE_CHANNEL,
]);

// Text commands whose usage accepts an argument, per command-catalog help lines.
const COMMANDS_WITH_INPUT = new Set([
  'history',
  'workspace',
  'conv',
  'sessionlist',
  'session',
  'reasoning',
  'model',
  'preset',
  'steer',
  'thread',
]);

const INPUT_OPTION_DESCRIPTION = '命令参数，用法与对应的文本命令一致';

function commandDescription(value) {
  return [...String(value ?? '')].slice(0, DISCORD_COMMAND_DESCRIPTION_MAX_LENGTH).join('');
}

/**
 * Validate a Discord application-command table before it is sent to the API.
 * Discord rejects the whole PUT when any entry is malformed, so this runs on
 * both the generated list and any caller-supplied list.
 */
export function validateDiscordCommands(commands, { allowEmpty = false } = {}) {
  if (!Array.isArray(commands)) {
    throw new TypeError('Discord application commands must be an array');
  }
  if (!allowEmpty && commands.length === 0) {
    throw new TypeError('Discord application commands must not be empty');
  }
  if (commands.length > DISCORD_COMMAND_MAX_COUNT) {
    throw new TypeError(`Discord supports at most ${DISCORD_COMMAND_MAX_COUNT} application commands`);
  }
  const names = new Set();
  for (const command of commands) {
    const name = String(command?.name ?? '');
    if (!DISCORD_COMMAND_NAME_PATTERN.test(name)) {
      throw new TypeError(`Invalid Discord application command name: ${name}`);
    }
    if (names.has(name)) {
      throw new TypeError(`Duplicate Discord application command name: ${name}`);
    }
    names.add(name);
    const description = String(command?.description ?? '');
    if (!description || [...description].length > DISCORD_COMMAND_DESCRIPTION_MAX_LENGTH) {
      throw new TypeError(`Invalid Discord application command description for: ${name}`);
    }
    for (const option of command?.options ?? []) {
      if (Number(option?.type) !== DISCORD_COMMAND_TEXT_OPTION_TYPE) {
        throw new TypeError(`Unsupported Discord command option type for: ${name}`);
      }
      const optionName = String(option?.name ?? '');
      if (!DISCORD_COMMAND_NAME_PATTERN.test(optionName)) {
        throw new TypeError(`Invalid Discord command option name for: ${name}`);
      }
      const optionDescription = String(option?.description ?? '');
      if (!optionDescription
        || [...optionDescription].length > DISCORD_COMMAND_DESCRIPTION_MAX_LENGTH) {
        throw new TypeError(`Invalid Discord command option description for: ${name}`);
      }
    }
  }
  return commands;
}

/**
 * Build the Discord application-command table from the shared catalog. The
 * catalog stays authoritative: aliases become their own entries (exactly like
 * the Telegram menu), and `privateOnly` narrows the interaction contexts.
 */
export function discordCommandDefinitions(catalog = SHARED_COMMAND_CATALOG, translate = t) {
  const commands = [];
  for (const item of commandsForChannel('discord', catalog)) {
    if (item.menuVisible === false) continue;
    for (const entry of [item, ...(item.aliases ?? [])]) {
      if (entry.menuVisible === false || entry.enabled === false) continue;
      if (entry.channels && !entry.channels.includes('discord')) continue;
      commands.push({
        name: entry.name,
        description: commandDescription(translate(entry.description ?? item.description)),
        ...(COMMANDS_WITH_INPUT.has(entry.name)
          ? {
              options: [{
                type: DISCORD_COMMAND_TEXT_OPTION_TYPE,
                name: DISCORD_COMMAND_INPUT_OPTION,
                description: commandDescription(translate(INPUT_OPTION_DESCRIPTION)),
                required: false,
                max_length: DISCORD_COMMAND_INPUT_MAX_LENGTH,
              }],
            }
          : {}),
        ...(item.privateOnly === true ? { contexts: [...DISCORD_PRIVATE_CONTEXTS] } : {}),
      });
    }
  }
  validateDiscordCommands(commands, { allowEmpty: true });
  return commands;
}

/** Every command name the bot advertises, primaries and aliases alike. */
export function discordCommandNames(catalog = SHARED_COMMAND_CATALOG) {
  return new Set(discordCommandDefinitions(catalog, (text) => text).map((command) => command.name));
}

/**
 * Rebuild the text command an interaction stands for, e.g. `/model 2 high`.
 * Returns null for anything the bot never registered, so an unknown or
 * component interaction can never leak into the model prompt as text.
 */
export function discordCommandText(interaction, catalog = SHARED_COMMAND_CATALOG) {
  if (Number(interaction?.type) !== DISCORD_APPLICATION_COMMAND_INTERACTION_TYPE) return null;
  const dataType = Number(interaction?.data?.type ?? DISCORD_COMMAND_CHAT_INPUT_TYPE);
  if (dataType !== DISCORD_COMMAND_CHAT_INPUT_TYPE) return null;
  const name = String(interaction?.data?.name ?? '').trim().toLowerCase();
  if (!DISCORD_COMMAND_NAME_PATTERN.test(name)) return null;
  if (!discordCommandNames(catalog).has(name)) return null;
  const option = (interaction?.data?.options ?? [])
    .find((entry) => entry?.name === DISCORD_COMMAND_INPUT_OPTION);
  const value = typeof option?.value === 'string' ? option.value.trim() : '';
  return value ? `/${name} ${value}` : `/${name}`;
}

function normalizeOption(option) {
  return {
    type: Number(option?.type),
    name: String(option?.name ?? ''),
    description: String(option?.description ?? ''),
    ...(option?.required === true ? { required: true } : {}),
    ...(Number.isSafeInteger(option?.max_length) ? { max_length: option.max_length } : {}),
  };
}

function normalizeContexts(value) {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const contexts = [...new Set(value.map(Number))].sort((left, right) => left - right);
  // Discord echoes the full default set for commands that never restricted it,
  // so an unrestricted command must not look different from an omitted field.
  const isDefault = contexts.length === DISCORD_DEFAULT_CONTEXTS.length
    && contexts.every((context, index) => context === DISCORD_DEFAULT_CONTEXTS[index]);
  return isDefault ? undefined : contexts;
}

/**
 * Canonicalize a command table for comparison. Discord's GET response carries
 * ids, versions and localization fields that a PUT never sends, so both sides
 * are reduced to the fields that actually describe the menu.
 */
export function normalizeDiscordCommandTable(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((command) => {
      const options = Array.isArray(command?.options) ? command.options.map(normalizeOption) : [];
      const contexts = normalizeContexts(command?.contexts);
      return {
        name: String(command?.name ?? ''),
        description: String(command?.description ?? ''),
        ...(options.length > 0 ? { options } : {}),
        ...(contexts ? { contexts } : {}),
      };
    })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * Register the command table, PUTting only when the live table differs. Discord
 * replaces the whole table in one request, so there is no per-command diffing.
 *
 * `applicationId` is required: the registration endpoint is documented only
 * against a real application id, not the `@me` alias.
 */
export async function syncDiscordCommands({
  api,
  commands,
  applicationId,
  guildId,
  signal,
} = {}) {
  validateDiscordCommands(commands, { allowEmpty: true });
  const desired = normalizeDiscordCommandTable(commands);
  // Feature detection keeps runtimes wired to a partial API stub (tests, older
  // callers) from failing startup over an optional capability.
  if (typeof api?.listApplicationCommands !== 'function'
    || typeof api?.setApplicationCommands !== 'function') {
    return { changed: false, skipped: true, count: desired.length };
  }
  const current = await api.listApplicationCommands({ applicationId, guildId, signal });
  const existing = normalizeDiscordCommandTable(current);
  if (JSON.stringify(existing) === JSON.stringify(desired)) {
    return { changed: false, skipped: false, count: desired.length };
  }
  await api.setApplicationCommands({ applicationId, guildId, commands: desired, signal });
  return { changed: true, skipped: false, count: desired.length };
}
