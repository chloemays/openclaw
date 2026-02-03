import { describe, it, expect } from "vitest";
import { extractFacts } from "./extraction.js";

describe("extractFacts", () => {
  const baseTimestamp = new Date("2026-02-03T12:00:00Z").getTime();

  describe("people extraction", () => {
    it("extracts names with first and last name", () => {
      const facts = extractFacts({
        content: "I had a meeting with John Smith yesterday.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.people.length).toBeGreaterThan(0);
      const john = facts.people.find((p) => p.name === "John Smith");
      expect(john).toBeDefined();
    });

    it("extracts multiple people", () => {
      const facts = extractFacts({
        content: "Sarah Johnson and Michael Brown are joining the team.",
        role: "user",
        timestamp: baseTimestamp,
      });

      const names = facts.people.map((p) => p.name);
      expect(names).toContain("Sarah Johnson");
      expect(names).toContain("Michael Brown");
    });

    it("extracts email addresses associated with people", () => {
      const facts = extractFacts({
        content: "Contact Alex Taylor at alex@example.com for more info.",
        role: "user",
        timestamp: baseTimestamp,
      });

      const alex = facts.people.find((p) => p.name === "Alex Taylor");
      expect(alex).toBeDefined();
      expect(alex?.attributes.email).toBe("alex@example.com");
    });

    it("does not extract common words as names", () => {
      const facts = extractFacts({
        content: "The new project is great and should work well.",
        role: "user",
        timestamp: baseTimestamp,
      });

      // Common words like "The", "This" should not be extracted as names
      const commonWordNames = facts.people.filter((p) =>
        ["The", "This", "That", "And", "Or"].includes(p.name),
      );
      expect(commonWordNames.length).toBe(0);
    });
  });

  describe("task extraction", () => {
    it("extracts TODO items", () => {
      const facts = extractFacts({
        content: "TODO: Review the documentation before the meeting.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.tasks.length).toBeGreaterThan(0);
      expect(facts.tasks[0].description.toLowerCase()).toContain("review");
      expect(facts.tasks[0].status).toBe("pending");
    });

    it("extracts 'need to' tasks", () => {
      const facts = extractFacts({
        content: "I need to finish the report by Friday.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.tasks.length).toBeGreaterThan(0);
      expect(facts.tasks[0].description.toLowerCase()).toContain("finish");
    });

    it("extracts urgent tasks with high priority", () => {
      const facts = extractFacts({
        content: "URGENT: Need to fix the critical bug immediately.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.tasks.length).toBeGreaterThan(0);
      expect(facts.tasks[0].priority).toBe("high");
    });

    it("extracts tasks with due dates", () => {
      const facts = extractFacts({
        content: "Need to submit the proposal by tomorrow.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.tasks.length).toBeGreaterThan(0);
      const task = facts.tasks[0];
      expect(task.dueDate).toBeDefined();
      expect(task.dueDate?.type).toBe("relative");
    });
  });

  describe("preference extraction", () => {
    it("extracts positive preferences", () => {
      const facts = extractFacts({
        content: "I really like using TypeScript for all my projects.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.preferences.length).toBeGreaterThan(0);
      const pref = facts.preferences[0];
      expect(pref.sentiment).toBe("positive");
      expect(pref.subject.toLowerCase()).toContain("typescript");
    });

    it("extracts negative preferences", () => {
      const facts = extractFacts({
        content: "I hate dealing with callback hell in JavaScript.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.preferences.length).toBeGreaterThan(0);
      const pref = facts.preferences[0];
      expect(pref.sentiment).toBe("negative");
      expect(pref.strength).toBeGreaterThan(0.8);
    });

    it("does not extract preferences from assistant messages", () => {
      const facts = extractFacts({
        content: "I really like TypeScript.",
        role: "assistant",
        timestamp: baseTimestamp,
      });

      expect(facts.preferences.length).toBe(0);
    });
  });

  describe("decision extraction", () => {
    it("extracts decisions", () => {
      const facts = extractFacts({
        content: "We decided to use React for the frontend.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.decisions.length).toBeGreaterThan(0);
      expect(facts.decisions[0].decision.toLowerCase()).toContain("react");
    });

    it('extracts "going with" decisions', () => {
      const facts = extractFacts({
        content: "We're going with the microservices architecture.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.decisions.length).toBeGreaterThan(0);
      expect(facts.decisions[0].decision.toLowerCase()).toContain("microservices");
    });
  });

  describe("event extraction", () => {
    it("extracts events with absolute dates", () => {
      const facts = extractFacts({
        content: "The conference is on March 15, 2026 in San Francisco.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const event = facts.events[0];
      expect(event.when).toBeDefined();
      expect(event.when?.type).toBe("absolute");
    });

    it("extracts events with relative dates", () => {
      const facts = extractFacts({
        content: "We have a team meeting next week.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const event = facts.events[0];
      expect(event.when).toBeDefined();
      expect(event.when?.type).toBe("relative");
    });

    it("extracts location from events", () => {
      const facts = extractFacts({
        content: "The meeting is tomorrow at the Main Office.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const event = facts.events[0];
      expect(event.where).toBeDefined();
    });
  });

  describe("date parsing", () => {
    it("parses 'today'", () => {
      const facts = extractFacts({
        content: "I have a dentist appointment today.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const event = facts.events[0];
      expect(event.when?.timestamp).toBeCloseTo(baseTimestamp, -4);
    });

    it("parses 'tomorrow'", () => {
      const facts = extractFacts({
        content: "The deadline is tomorrow.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const tomorrow = baseTimestamp + 24 * 60 * 60 * 1000;
      expect(facts.events[0].when?.timestamp).toBeCloseTo(tomorrow, -4);
    });

    it("parses 'in N days'", () => {
      const facts = extractFacts({
        content: "The project is due in 5 days.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const expected = baseTimestamp + 5 * 24 * 60 * 60 * 1000;
      expect(facts.events[0].when?.timestamp).toBeCloseTo(expected, -4);
    });

    it("parses 'N days ago'", () => {
      const facts = extractFacts({
        content: "The meeting happened 3 days ago.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.events.length).toBeGreaterThan(0);
      const expected = baseTimestamp - 3 * 24 * 60 * 60 * 1000;
      expect(facts.events[0].when?.timestamp).toBeCloseTo(expected, -4);
    });
  });

  describe("general facts extraction", () => {
    it("extracts factual statements", () => {
      const facts = extractFacts({
        content: "The API uses OAuth 2.0 for authentication.",
        role: "user",
        timestamp: baseTimestamp,
      });

      expect(facts.facts.length).toBeGreaterThan(0);
    });

    it("assigns lower confidence to uncertain statements", () => {
      const facts = extractFacts({
        content: "The server might be experiencing issues.",
        role: "user",
        timestamp: baseTimestamp,
      });

      if (facts.facts.length > 0) {
        expect(facts.facts[0].confidence).toBeLessThan(0.6);
      }
    });

    it("assigns higher confidence to certain statements", () => {
      const facts = extractFacts({
        content: "The server definitely has 16GB of RAM.",
        role: "user",
        timestamp: baseTimestamp,
      });

      if (facts.facts.length > 0) {
        expect(facts.facts[0].confidence).toBeGreaterThan(0.8);
      }
    });
  });
});
