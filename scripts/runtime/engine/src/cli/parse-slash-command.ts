export interface ParsedSlashCommand {
  slug: string;
  args: string;
  argsLower: string;
}

const CIRCUIT_SLASH_COMMAND_PATTERN = /\/circuit:([a-z:-]+)([^\r\n]*)/i;

export function parseCircuitSlashCommand(prompt: string): ParsedSlashCommand | null {
  const match = CIRCUIT_SLASH_COMMAND_PATTERN.exec(prompt);
  if (!match) {
    return null;
  }

  const slug = match[1].toLowerCase();
  const args = match[2].trimStart();
  return {
    slug,
    args,
    argsLower: args.toLowerCase(),
  };
}
