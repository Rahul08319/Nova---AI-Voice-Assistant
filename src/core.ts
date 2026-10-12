/**
 * TypeSafe System One Core Engine for Voice Command Assistant
 * Implements bounded semantic tool routing, categorization, and prompt evaluation.
 */

export type ToolCategory = 'utility' | 'knowledge' | 'media' | 'conversation';

export interface TypeSafeChoiceOption {
  id: ToolCategory;
  label: string;
  description: string;
  tools: string[];
}

/**
 * Tool categorization options following TypeSafe Choice primitive principles:
 * - Mutually exclusive categories
 * - Neutral, unambiguous descriptions
 * - Explicit grounding in tool capabilities
 */
export const TOOL_CATEGORIES: Record<ToolCategory, TypeSafeChoiceOption> = {
  utility: {
    id: 'utility',
    label: 'System Utility',
    description: 'Time queries, local device status, environmental weather checks, or clock calculations.',
    tools: ['get_current_time', 'get_weather']
  },
  knowledge: {
    id: 'knowledge',
    label: 'Knowledge & Search',
    description: 'Factual lookups, current events, web retrieval, or information requiring external search.',
    tools: ['search_google']
  },
  media: {
    id: 'media',
    label: 'Media & Audio Signal',
    description: 'Playback of sound effects, alerts, custom audio clips, or audio tag-based triggers.',
    tools: ['play_custom_clip']
  },
  conversation: {
    id: 'conversation',
    label: 'Direct Conversation',
    description: 'Standard conversational interaction, greetings, explanations, or dialogue without tool execution.',
    tools: []
  }
};

/**
 * Question instruction for the TypeSafe Choice primitive.
 * Adheres to TypeSafe prompting best practices:
 * 1. Neutral, objective phrasing without suggestive bias.
 * 2. Closed-set mutually exclusive options.
 * 3. Incorporates current conversation context and recent user utterance.
 * 4. Eliminates ambiguous compound questions.
 */
export interface QuestionInstructionConfig {
  userUtterance: string;
  activeTools: string[];
  recentHistory?: string[];
}

export function buildToolCategorizationQuestion(config: QuestionInstructionConfig): {
  question: string;
  choices: string[];
  context: string;
} {
  const choices = Object.values(TOOL_CATEGORIES).map(
    c => `${c.id}: ${c.description} (Associated tools: ${c.tools.length > 0 ? c.tools.join(', ') : 'none'})`
  );

  const context = `User Input: "${config.userUtterance.trim()}"\nActive Tools Available: [${config.activeTools.join(', ')}]${
    config.recentHistory && config.recentHistory.length > 0
      ? `\nRecent Context:\n${config.recentHistory.slice(-3).map(h => ` - ${h}`).join('\n')}`
      : ''
  }`;

  const question = 
    "Categorize the user's spoken intent into exactly one primary category to determine necessary tool execution.";

  return {
    question,
    choices,
    context
  };
}

/**
 * Fast-path rule evaluation before or alongside System One Choice primitive.
 * Enforces determinism for exact matches while delegating semantic ambiguities to TypeSafe.
 */
export function classifyIntentHeuristic(utterance: string): ToolCategory {
  const clean = utterance.toLowerCase().trim();

  // Utility heuristics
  if (/\b(time|what time|clock|hour|weather|temperature|forecast|climate)\b/i.test(clean)) {
    return 'utility';
  }

  // Media heuristics
  if (/\b(play|sound|clip|effect|audio|noise|alarm|siren|intro|jingle)\b/i.test(clean)) {
    return 'media';
  }

  // Knowledge search heuristics
  if (/\b(search|google|who is|what is|find out|look up|news|latest|define)\b/i.test(clean)) {
    return 'knowledge';
  }

  return 'conversation';
}
