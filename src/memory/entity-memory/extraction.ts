/**
 * Memory Extraction Pipeline
 *
 * Automatically extracts structured information from conversations without
 * requiring LLM calls. Uses pattern matching, heuristics, and lightweight NLP.
 */

import type { EntityMemoryStore } from "./store.js";
import type { ExtractedFacts, ImportanceLevel, DateReference, MemorySource } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("entity-memory:extraction");

// Common patterns for extraction
const PATTERNS = {
  // Person names (capitalized words, common name patterns)
  personName: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g,

  // Email addresses
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,

  // Phone numbers
  phone: /\b(?:\+?1?[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,

  // URLs
  url: /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi,

  // Dates - various formats
  dateAbsolute:
    /\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/gi,

  // Relative dates
  dateRelative:
    /\b(?:today|tomorrow|yesterday|next\s+(?:week|month|year)|last\s+(?:week|month|year)|in\s+\d+\s+(?:days?|weeks?|months?|years?)|(?:\d+\s+)?(?:days?|weeks?|months?|years?)\s+(?:ago|from\s+now))\b/gi,

  // Times
  time: /\b(?:\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|AM|PM)?|\d{1,2}\s*(?:am|pm|AM|PM))\b/g,

  // Task indicators
  taskIndicator:
    /\b(?:TODO|FIXME|HACK|NOTE|XXX|need\s+to|should|must|have\s+to|going\s+to|will\s+(?:need\s+to)?|please|can\s+you|could\s+you|would\s+you|remind\s+me\s+to|don't\s+forget\s+to|make\s+sure\s+to|remember\s+to)\b/gi,

  // Preference indicators
  preferencePositive:
    /\b(?:I\s+(?:love|like|prefer|enjoy|want|need|appreciate)|my\s+favorite|best\s+(?:way|method)|always\s+use|really\s+(?:like|enjoy|want))\b/gi,
  preferenceNegative:
    /\b(?:I\s+(?:hate|dislike|don't\s+like|can't\s+stand|avoid)|never\s+use|worst|don't\s+want|not\s+a\s+fan)\b/gi,

  // Decision indicators
  decisionIndicator:
    /\b(?:decided\s+to|going\s+with|chose\s+to|will\s+(?:use|go\s+with)|let's\s+(?:use|go\s+with)|the\s+plan\s+is|we'll\s+(?:use|do))\b/gi,

  // Location patterns
  location:
    /\b(?:at\s+(?:the\s+)?|in\s+(?:the\s+)?|from\s+(?:the\s+)?|to\s+(?:the\s+)?)[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/gi,

  // Organization patterns
  organization:
    /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:Inc|Corp|LLC|Ltd|Company|Team|Group|Department|Division)|(?:the\s+)?[A-Z][A-Z]+(?:\s+[A-Z][A-Z]+)*)\b/g,

  // Common personal pronouns to avoid extracting as names
  pronouns: /\b(?:I|you|he|she|it|we|they|me|him|her|us|them|my|your|his|its|our|their)\b/gi,

  // Common words that shouldn't be names
  commonWords:
    /\b(?:The|This|That|These|Those|A|An|And|Or|But|If|Then|When|Where|What|Why|How|Can|Could|Would|Should|Will|Have|Has|Had|Do|Does|Did|Is|Are|Was|Were|Been|Being|Be|Not|No|Yes|Maybe|Perhaps|Also|Just|Only|Even|Still|Already|Yet|Now|Then|Here|There|Up|Down|In|Out|On|Off|Over|Under|About|After|Before|Between|Through|During|Without|Within|Along|Across|Behind|Below|Above|Beyond|Into|From|With|Upon|Until|Since|While|Because|Although|Though|Unless|Whether|Either|Neither|Both|Each|Every|Some|Any|Many|Much|More|Most|Few|Little|Less|Least|Other|Another|Such|Same|Different|New|Old|Good|Bad|Great|Small|Large|Long|Short|High|Low|First|Last|Next|Early|Late|Right|Wrong|True|False|Real|Sure|Certain|Possible|Likely|Probably|Maybe|Actually|Really|Very|Quite|Rather|Too|Enough|Almost|Nearly|Hardly|Barely|Exactly|Especially|Particularly|Mainly|Mostly|Generally|Usually|Often|Sometimes|Always|Never|Ever|Else|Otherwise|However|Therefore|Thus|Hence|Moreover|Furthermore|Meanwhile|Nevertheless|Nonetheless|Instead|Otherwise|Anyway|Anyway|Regardless|Notwithstanding|Contact|Please|Hello|Dear|Thanks|Thank|Sorry|Welcome|Regarding|Re|Note|See|Visit|Call|Email|Meet|Ask|Tell|Send|Get|Let|Make|Take|Give)\b/gi,
};

// Common first names to help identify people
const COMMON_FIRST_NAMES = new Set([
  "james",
  "john",
  "robert",
  "michael",
  "william",
  "david",
  "richard",
  "joseph",
  "thomas",
  "charles",
  "mary",
  "patricia",
  "jennifer",
  "linda",
  "elizabeth",
  "barbara",
  "susan",
  "jessica",
  "sarah",
  "karen",
  "alex",
  "sam",
  "chris",
  "jordan",
  "taylor",
  "morgan",
  "casey",
  "riley",
  "jamie",
  "drew",
  "peter",
  "paul",
  "mark",
  "steve",
  "steven",
  "andrew",
  "brian",
  "kevin",
  "jason",
  "matthew",
  "emma",
  "olivia",
  "ava",
  "sophia",
  "isabella",
  "mia",
  "charlotte",
  "amelia",
  "harper",
  "evelyn",
]);

/**
 * Extract facts from a conversation message
 */
export function extractFacts(params: {
  content: string;
  role: "user" | "assistant";
  timestamp: number;
  sessionKey?: string;
}): ExtractedFacts {
  const { content, role, timestamp } = params;

  const facts: ExtractedFacts = {
    people: [],
    events: [],
    preferences: [],
    tasks: [],
    facts: [],
    decisions: [],
  };

  // Extract people
  const people = extractPeople(content);
  facts.people = people;

  // Extract tasks
  const tasks = extractTasks(content, timestamp);
  facts.tasks = tasks;

  // Extract preferences (mainly from user messages)
  if (role === "user") {
    const preferences = extractPreferences(content);
    facts.preferences = preferences;
  }

  // Extract decisions
  const decisions = extractDecisions(content, timestamp);
  facts.decisions = decisions;

  // Extract events with dates
  const events = extractEvents(content, timestamp);
  facts.events = events;

  // Extract general facts
  const generalFacts = extractGeneralFacts(content, timestamp);
  facts.facts = generalFacts;

  return facts;
}

/**
 * Extract people mentioned in text
 */
function extractPeople(
  content: string,
): Array<{ name: string; attributes: Record<string, unknown>; context: string }> {
  const people: Array<{ name: string; attributes: Record<string, unknown>; context: string }> = [];
  const seen = new Set<string>();

  // Find potential names
  const matches = content.matchAll(PATTERNS.personName);
  for (const match of matches) {
    let name = match[0];
    let lower = name.toLowerCase();

    // Skip common words and pronouns
    // Reset lastIndex to avoid global regex state issues
    PATTERNS.commonWords.lastIndex = 0;
    PATTERNS.pronouns.lastIndex = 0;

    // If the match starts with a common word (e.g., "Contact Alex Taylor"),
    // try stripping it to get the actual name
    const words = name.split(" ");
    if (words.length > 1) {
      const firstWord = words[0];
      PATTERNS.commonWords.lastIndex = 0;
      if (PATTERNS.commonWords.test(firstWord)) {
        // Remove the common word prefix and use the rest as the name
        name = words.slice(1).join(" ");
        lower = name.toLowerCase();
      }
    }

    if (PATTERNS.commonWords.test(name)) {
      continue;
    }
    if (PATTERNS.pronouns.test(name)) {
      continue;
    }

    // Check if it looks like a name
    const firstName = name.split(" ")[0].toLowerCase();
    const isLikelyName = COMMON_FIRST_NAMES.has(firstName) || name.split(" ").length >= 2;

    if (!isLikelyName) {
      continue;
    }
    if (seen.has(lower)) {
      continue;
    }
    seen.add(lower);

    // Extract context around the name
    const index = match.index;
    const contextStart = Math.max(0, index - 50);
    const contextEnd = Math.min(content.length, index + name.length + 50);
    const context = content.slice(contextStart, contextEnd).trim();

    // Try to extract attributes from context
    const attributes: Record<string, unknown> = {};

    // Check for email
    const emailMatch = content.match(new RegExp(`${name}[^@]*?(${PATTERNS.email.source})`, "i"));
    if (emailMatch) {
      attributes.email = emailMatch[1];
    }

    // Check for phone
    const phoneMatch = content.match(new RegExp(`${name}[^0-9]*?(${PATTERNS.phone.source})`, "i"));
    if (phoneMatch) {
      attributes.phone = phoneMatch[1];
    }

    people.push({ name, attributes, context });
  }

  return people;
}

/**
 * Extract tasks from text
 */
function extractTasks(
  content: string,
  timestamp: number,
): Array<{
  description: string;
  assignee?: string;
  dueDate?: DateReference;
  priority?: ImportanceLevel;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}> {
  const tasks: Array<{
    description: string;
    assignee?: string;
    dueDate?: DateReference;
    priority?: ImportanceLevel;
    status: "pending" | "in_progress" | "completed" | "cancelled";
  }> = [];

  // Find task indicators
  const sentences = content.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }

    // Reset lastIndex to avoid global regex state issues
    PATTERNS.taskIndicator.lastIndex = 0;
    if (PATTERNS.taskIndicator.test(trimmed)) {
      // Clean up the task description
      let description = trimmed
        .replace(/^(?:TODO|FIXME|HACK|NOTE|XXX)[:\s]*/i, "")
        .replace(/^(?:need\s+to|should|must|have\s+to|going\s+to|will\s+(?:need\s+to)?)\s+/i, "")
        .replace(/^(?:please|can\s+you|could\s+you|would\s+you)\s+/i, "")
        .replace(/^(?:remind\s+me\s+to|don't\s+forget\s+to|make\s+sure\s+to|remember\s+to)\s+/i, "")
        .trim();

      if (description.length < 5) {
        continue;
      }

      // Try to extract due date
      const dueDate = extractDateFromText(trimmed, timestamp);

      // Determine priority from context
      let priority: ImportanceLevel = "medium";
      if (/urgent|asap|immediately|critical|important/i.test(trimmed)) {
        priority = "high";
      } else if (/whenever|eventually|someday|low\s+priority/i.test(trimmed)) {
        priority = "low";
      }

      tasks.push({
        description,
        dueDate: dueDate ?? undefined,
        priority,
        status: "pending",
      });
    }
  }

  return tasks;
}

/**
 * Extract preferences from text
 */
function extractPreferences(content: string): Array<{
  subject: string;
  sentiment: "positive" | "negative" | "neutral";
  strength: number;
  context: string;
}> {
  const preferences: Array<{
    subject: string;
    sentiment: "positive" | "negative" | "neutral";
    strength: number;
    context: string;
  }> = [];

  const sentences = content.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }

    let sentiment: "positive" | "negative" | "neutral" = "neutral";
    let strength = 0.5;

    // Reset lastIndex to avoid global regex state issues
    PATTERNS.preferencePositive.lastIndex = 0;
    PATTERNS.preferenceNegative.lastIndex = 0;
    if (PATTERNS.preferencePositive.test(trimmed)) {
      sentiment = "positive";
      strength = /love|favorite|always/i.test(trimmed) ? 0.9 : 0.7;
    } else if (PATTERNS.preferenceNegative.test(trimmed)) {
      sentiment = "negative";
      strength = /hate|can't\s+stand|worst/i.test(trimmed) ? 0.9 : 0.7;
    } else {
      continue;
    }

    // Extract the subject of the preference
    let subject = trimmed
      .replace(PATTERNS.preferencePositive, "")
      .replace(PATTERNS.preferenceNegative, "")
      .replace(/^(?:that|when|how|the|a|an)\s+/i, "")
      .trim();

    if (subject.length < 3 || subject.length > 100) {
      continue;
    }

    preferences.push({
      subject,
      sentiment,
      strength,
      context: trimmed,
    });
  }

  return preferences;
}

/**
 * Extract decisions from text
 */
function extractDecisions(
  content: string,
  timestamp: number,
): Array<{
  decision: string;
  reasoning?: string;
  alternatives?: string[];
  madeBy?: string;
  madeAt?: DateReference;
}> {
  const decisions: Array<{
    decision: string;
    reasoning?: string;
    alternatives?: string[];
    madeBy?: string;
    madeAt?: DateReference;
  }> = [];

  const sentences = content.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }

    // Reset lastIndex to avoid global regex state issues
    PATTERNS.decisionIndicator.lastIndex = 0;
    if (PATTERNS.decisionIndicator.test(trimmed)) {
      let decision = trimmed
        .replace(PATTERNS.decisionIndicator, "")
        .replace(/^(?:that|to)\s+/i, "")
        .trim();

      if (decision.length < 5) {
        continue;
      }

      decisions.push({
        decision,
        madeAt: {
          originalText: "now",
          timestamp,
          confidence: 0.9,
          type: "absolute",
        },
      });
    }
  }

  return decisions;
}

/**
 * Extract events from text
 */
function extractEvents(
  content: string,
  timestamp: number,
): Array<{
  description: string;
  when?: DateReference;
  where?: string;
  who?: string[];
}> {
  const events: Array<{
    description: string;
    when?: DateReference;
    where?: string;
    who?: string[];
  }> = [];

  // Look for date references and extract surrounding context
  const absoluteDates = content.matchAll(PATTERNS.dateAbsolute);
  const relativeDates = content.matchAll(PATTERNS.dateRelative);

  for (const match of [...absoluteDates, ...relativeDates]) {
    const dateText = match[0];
    const index = match.index;

    // Extract sentence containing the date
    const sentenceStart = content.lastIndexOf(".", index - 1) + 1;
    const sentenceEnd = content.indexOf(".", index) + 1 || content.length;
    const sentence = content.slice(sentenceStart, sentenceEnd).trim();

    if (sentence.length < 10) {
      continue;
    }

    const dateRef = parseDate(dateText, timestamp);
    if (!dateRef) {
      continue;
    }

    // Extract location if present
    const locationMatch = sentence.match(PATTERNS.location);
    const where = locationMatch
      ? locationMatch[0].replace(/^(?:at|in|from|to)\s+(?:the\s+)?/i, "")
      : undefined;

    // Extract people mentioned
    const people = extractPeople(sentence);
    const who = people.length > 0 ? people.map((p) => p.name) : undefined;

    events.push({
      description: sentence,
      when: dateRef,
      where,
      who,
    });
  }

  return events;
}

/**
 * Extract general facts from text
 */
function extractGeneralFacts(
  content: string,
  timestamp: number,
): Array<{
  statement: string;
  subject?: string;
  confidence: number;
  temporal?: DateReference;
}> {
  const facts: Array<{
    statement: string;
    subject?: string;
    confidence: number;
    temporal?: DateReference;
  }> = [];

  // Look for factual statements (declarative sentences with "is", "are", "has", "have", etc.)
  const factPatterns = [
    /\b(?:is|are|was|were)\s+(?:a|an|the)?\s*[A-Za-z]+/gi,
    /\b(?:has|have|had)\s+[A-Za-z]+/gi,
    /\b(?:uses?|works?\s+(?:with|at|for)|lives?\s+(?:in|at)|knows?)\s+/gi,
  ];

  const sentences = content.split(/[.!?]+/);
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.length < 15) {
      continue;
    }

    // Skip questions
    if (
      trimmed.includes("?") ||
      /^(?:who|what|where|when|why|how|is|are|can|could|would|should|do|does)/i.test(trimmed)
    ) {
      continue;
    }

    // Check if it matches fact patterns
    let isFactual = false;
    for (const pattern of factPatterns) {
      if (pattern.test(trimmed)) {
        isFactual = true;
        break;
      }
    }

    if (!isFactual) {
      continue;
    }

    // Calculate confidence based on language certainty markers
    let confidence = 0.7;
    if (/definitely|certainly|always|never|absolutely/i.test(trimmed)) {
      confidence = 0.9;
    } else if (/probably|likely|usually|often|sometimes/i.test(trimmed)) {
      confidence = 0.6;
    } else if (/maybe|might|possibly|perhaps|could be/i.test(trimmed)) {
      confidence = 0.4;
    }

    // Extract temporal reference if present
    const dateRef = extractDateFromText(trimmed, timestamp);

    facts.push({
      statement: trimmed,
      confidence,
      temporal: dateRef ?? undefined,
    });
  }

  return facts;
}

/**
 * Extract date from text and return DateReference
 */
function extractDateFromText(text: string, baseTimestamp: number): DateReference | null {
  // Try absolute dates first
  const absoluteMatch = text.match(PATTERNS.dateAbsolute);
  if (absoluteMatch) {
    const parsed = parseDate(absoluteMatch[0], baseTimestamp);
    if (parsed) {
      return parsed;
    }
  }

  // Try relative dates
  const relativeMatch = text.match(PATTERNS.dateRelative);
  if (relativeMatch) {
    const parsed = parseDate(relativeMatch[0], baseTimestamp);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

/**
 * Parse a date string into a DateReference
 */
function parseDate(dateStr: string, baseTimestamp: number): DateReference | null {
  const lower = dateStr.toLowerCase().trim();
  const base = new Date(baseTimestamp);

  // Handle relative dates
  if (lower === "today") {
    return {
      originalText: dateStr,
      timestamp: baseTimestamp,
      confidence: 0.95,
      type: "relative",
    };
  }

  if (lower === "tomorrow") {
    const tomorrow = new Date(base);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return {
      originalText: dateStr,
      timestamp: tomorrow.getTime(),
      confidence: 0.95,
      type: "relative",
    };
  }

  if (lower === "yesterday") {
    const yesterday = new Date(base);
    yesterday.setDate(yesterday.getDate() - 1);
    return {
      originalText: dateStr,
      timestamp: yesterday.getTime(),
      confidence: 0.95,
      type: "relative",
    };
  }

  // Handle "next week/month/year"
  const nextMatch = lower.match(/next\s+(week|month|year)/);
  if (nextMatch) {
    const unit = nextMatch[1];
    const future = new Date(base);
    if (unit === "week") {
      future.setDate(future.getDate() + 7);
    } else if (unit === "month") {
      future.setMonth(future.getMonth() + 1);
    } else if (unit === "year") {
      future.setFullYear(future.getFullYear() + 1);
    }
    return {
      originalText: dateStr,
      timestamp: future.getTime(),
      confidence: 0.8,
      type: "relative",
    };
  }

  // Handle "last week/month/year"
  const lastMatch = lower.match(/last\s+(week|month|year)/);
  if (lastMatch) {
    const unit = lastMatch[1];
    const past = new Date(base);
    if (unit === "week") {
      past.setDate(past.getDate() - 7);
    } else if (unit === "month") {
      past.setMonth(past.getMonth() - 1);
    } else if (unit === "year") {
      past.setFullYear(past.getFullYear() - 1);
    }
    return {
      originalText: dateStr,
      timestamp: past.getTime(),
      confidence: 0.8,
      type: "relative",
    };
  }

  // Handle "in N days/weeks/months/years"
  const inMatch = lower.match(/in\s+(\d+)\s+(days?|weeks?|months?|years?)/);
  if (inMatch) {
    const num = parseInt(inMatch[1], 10);
    const unit = inMatch[2].replace(/s$/, "");
    const future = new Date(base);
    if (unit === "day") {
      future.setDate(future.getDate() + num);
    } else if (unit === "week") {
      future.setDate(future.getDate() + num * 7);
    } else if (unit === "month") {
      future.setMonth(future.getMonth() + num);
    } else if (unit === "year") {
      future.setFullYear(future.getFullYear() + num);
    }
    return {
      originalText: dateStr,
      timestamp: future.getTime(),
      confidence: 0.85,
      type: "relative",
    };
  }

  // Handle "N days/weeks/months/years ago"
  const agoMatch = lower.match(/(\d+)\s+(days?|weeks?|months?|years?)\s+ago/);
  if (agoMatch) {
    const num = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2].replace(/s$/, "");
    const past = new Date(base);
    if (unit === "day") {
      past.setDate(past.getDate() - num);
    } else if (unit === "week") {
      past.setDate(past.getDate() - num * 7);
    } else if (unit === "month") {
      past.setMonth(past.getMonth() - num);
    } else if (unit === "year") {
      past.setFullYear(past.getFullYear() - num);
    }
    return {
      originalText: dateStr,
      timestamp: past.getTime(),
      confidence: 0.85,
      type: "relative",
    };
  }

  // Try parsing absolute date
  try {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      return {
        originalText: dateStr,
        timestamp: parsed.getTime(),
        confidence: 0.9,
        type: "absolute",
      };
    }
  } catch {}

  return null;
}

/**
 * Process extracted facts and store them in the memory store
 */
export async function processAndStoreFacts(params: {
  store: EntityMemoryStore;
  facts: ExtractedFacts;
  source: MemorySource;
  agentId: string;
}): Promise<void> {
  const { store, facts, source } = params;

  // Store people
  for (const person of facts.people) {
    await store.store({
      type: "person",
      content: person.name,
      attributes: person.attributes,
      importance: "medium",
      confidence: 0.8,
      source,
      tags: ["auto-extracted", "person"],
    });
  }

  // Store tasks
  for (const task of facts.tasks) {
    await store.store({
      type: "task",
      content: task.description,
      attributes: {
        assignee: task.assignee,
        priority: task.priority,
        status: task.status,
      },
      importance: task.priority ?? "medium",
      confidence: 0.85,
      source,
      tags: ["auto-extracted", "task"],
      temporal: task.dueDate
        ? {
            relevantUntil: task.dueDate.timestamp,
            dateReferences: [task.dueDate],
          }
        : undefined,
    });
  }

  // Store preferences
  for (const pref of facts.preferences) {
    await store.store({
      type: "preference",
      content: pref.subject,
      attributes: {
        sentiment: pref.sentiment,
        strength: pref.strength,
        context: pref.context,
      },
      importance: pref.strength > 0.8 ? "high" : "medium",
      confidence: pref.strength,
      source,
      tags: ["auto-extracted", "preference", pref.sentiment],
    });
  }

  // Store decisions
  for (const decision of facts.decisions) {
    await store.store({
      type: "decision",
      content: decision.decision,
      attributes: {
        reasoning: decision.reasoning,
        alternatives: decision.alternatives,
        madeBy: decision.madeBy,
      },
      importance: "high",
      confidence: 0.85,
      source,
      tags: ["auto-extracted", "decision"],
      temporal: decision.madeAt
        ? {
            dateReferences: [decision.madeAt],
          }
        : undefined,
    });
  }

  // Store events
  for (const event of facts.events) {
    await store.store({
      type: "event",
      content: event.description,
      attributes: {
        where: event.where,
        who: event.who,
      },
      importance: "medium",
      confidence: 0.75,
      source,
      tags: ["auto-extracted", "event"],
      temporal: event.when
        ? {
            relevantFrom: event.when.timestamp,
            dateReferences: [event.when],
          }
        : undefined,
    });
  }

  // Store general facts
  for (const fact of facts.facts) {
    await store.store({
      type: "fact",
      content: fact.statement,
      attributes: {
        subject: fact.subject,
      },
      importance: "low",
      confidence: fact.confidence,
      source,
      tags: ["auto-extracted", "fact"],
      temporal: fact.temporal
        ? {
            dateReferences: [fact.temporal],
          }
        : undefined,
    });
  }

  log.debug("Processed and stored extracted facts", {
    people: facts.people.length,
    tasks: facts.tasks.length,
    preferences: facts.preferences.length,
    decisions: facts.decisions.length,
    events: facts.events.length,
    facts: facts.facts.length,
  });
}
