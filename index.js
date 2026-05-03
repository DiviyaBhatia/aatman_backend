// ================= SETUP =================
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Groq = require("groq-sdk");

const app = express();
app.use(cors());
app.use(express.json());

// ================= LLM =================
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

async function callLLM(prompt) {
  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "Return ONLY valid JSON. If the requested language is Hindi or Marathi, you MUST use the Devanagari script exclusively. NEVER use Japanese, Kanji, or Chinese characters. Ensure the translation is natural and accurate." },
        { role: "user", content: prompt }
      ]
    });

    return response.choices[0].message.content;
  } catch (err) {
    console.error("LLM Error:", err.message);
    return null;
  }
}

function safeParseJSON(text) {
  try {
    if (!text) return null;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ================= SESSION =================
let session = {
  onboarding: {},
  goals: [],
  combinedPlan: null,
  lastEvaluation: null
};


// ================= BASIC ROUTES =================
app.get("/", (req, res) => {
  res.send("API running");
});

app.post("/reset", (req, res) => {
  session = {
    onboarding: {},
    goals: [],
    combinedPlan: null,
    lastEvaluation: null
  };
  res.json({ message: "Session reset" });
});

// ================= ONBOARDING =================
app.post("/onboarding", (req, res) => {
  const { name, free_time, language } = req.body;

  if (!name || !free_time) {
    return res.status(400).json({ error: "Missing onboarding data" });
  }

  session.onboarding = { name, free_time, language: language || "English" };

  res.json({ message: "Onboarding saved" });
});

// ================= GOALS =================
app.post("/start-goal", async (req, res) => {
  const { goal, timeline } = req.body;

  if (!goal || !timeline) {
    return res.status(400).json({ error: "Missing goal data" });
  }

  // 🔥 normalize using LLM
  const cleanPrompt = `
Convert this into a clear, simple fitness goal in English:

"${goal}"

Rules:
- Keep meaning same
- Make it short
- Example: "run 5 km"

Return JSON:
{ "goal": "" }
`;

  const ai = await callLLM(cleanPrompt);
  const parsed = safeParseJSON(ai);

  const cleanGoal = parsed?.goal || goal;

  const newGoal = {
    id: Date.now(),
    title: cleanGoal.toLowerCase(),
    original_input: goal, // 👈 keep original for UI
    timeline,
    domain: "fitness",
    answers: [],
    context: {},
    schedule: {},
    completedToday: false,
    repeatNextDay: false,
    lastEvaluation: null
  };

  session.goals.push(newGoal);
  res.json({ goal: newGoal });
});

// ================= CONTEXT QUESTIONS =================
app.post("/generate-questions", async (req, res) => {
  if (!session.goals.length) {
    return res.status(400).json({ error: "No goals found" });
  }

  const results = [];
  const language = session.onboarding?.language || "English";

  for (let goal of session.goals) {
  const prompt = `
Goal: ${goal.title}
Domain: fitness
Language: ${session.onboarding?.language || "English"}
Generate 3 SIMPLE multiple-choice questions to understand the user’s starting point for fitness.

Purpose:
- Understand current activity level
- Understand comfort with exercise
- Understand readiness to start

STRICT RULES:
- Questions must be VERY easy to answer
- No typing required
- Each question must have 3–4 SHORT options
- Keep language friendly, simple, and encouraging
- Avoid technical or intimidating words

FOCUS:
1. How active they currently are
2. How comfortable they feel doing exercise
3. Their starting level / readiness

STYLE:
- Positive and non-judgmental
- Beginner-friendly (age 40+)
- No mention of pain, injury, or limitations unless user brings it up

GOOD EXAMPLES:
- "How active are you currently?"
- "How comfortable are you with doing basic exercises?"
- "How would you describe your current fitness level?"

Return JSON:
{
  "questions": [
    {
      "question": "",
      "options": ["", "", "", ""]
    }
  ]
}
`;

    const ai = await callLLM(prompt);
    const parsed = safeParseJSON(ai);

    if (!parsed) {
      return res.status(500).json({ error: "Question generation failed" });
    }

    goal.questions = parsed.questions;

    results.push({
      goalId: goal.id,
      goal: goal.title,
      domain: goal.domain,
      questions: parsed.questions
    });
  }

  res.json({ data: results });
});

// ================= SAVE CONTEXT =================
app.post("/submit-answers", (req, res) => {
  const { goalId, answers } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) return res.status(400).json({ error: "Goal not found" });

  goal.answers = answers;

 goal.context = {
  activity_level: answers[0],
  comfort_level: answers[1],
  fitness_level: answers[2]
};

  res.json({ message: "Context saved" });
});

// ================= SCHEDULE QUESTIONS =================
app.post("/generate-schedule-questions", (req, res) => {
  const { goalId } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) {
    return res.status(400).json({ error: "Goal not found" });
  }

  const language = session.onboarding?.language || "English";
  const onboardingTime = session.onboarding?.preferred_time || "evening";

  // 👇 time ranges
  const timeRanges = {
    morning: [6, 10],
    afternoon: [12, 16],
    evening: [16, 20],
    night: [20, 24]
  };

  const [start, end] = timeRanges[onboardingTime] || [16, 20];

  // 👇 generate 1-hour slots
  const timeSlots = [];
  for (let h = start; h < end; h++) {
    timeSlots.push(`${h}:00 - ${h + 1}:00`);
  }

  // 🔥 FINAL STRUCTURED QUESTIONS (NO LLM)
 const translations = {
  English: {
    time: "How much time can you give daily?",
    when: "When do you prefer to exercise?",
    consistency: "How many days a week can you realistically commit?"
  },
  Hindi: {
    time: "आप रोज़ कितना समय दे सकते हैं?",
    when: "आप व्यायाम कब करना पसंद करेंगे?",
    consistency: "आप हफ्ते में कितने दिन नियमित रूप से कर सकते हैं?"
  },
  Marathi: {
    time: "तुम्ही दररोज किती वेळ देऊ शकता?",
    when: "तुम्हाला व्यायाम कधी करायला आवडेल?",
    consistency: "तुम्ही आठवड्यात किती दिवस नियमित करू शकता?"
  }
};

const lang = session.onboarding?.language || "English";
const t = translations[lang] || translations["English"];

const questions = [
  {
    type: "number",
    question: t.time,
    key: "daily_minutes",
    min: 10,
    max: 120,
    step: 10,
    default: 20
  },
  {
    type: "select",
    question: t.when,
    key: "preferred_time",
    options: [...timeSlots, "Other"]
  },
  {
    type: "select",
    question: t.consistency,
    key: "consistency",
    options: ["2–3 days", "3–4 days", "5–6 days"]
  }
];

  goal.scheduleQuestions = questions;

  res.json({ questions });
});

// ================= SCHEDULE =================
app.post("/submit-schedule", (req, res) => {
  const { goalId, answers } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) return res.status(400).json({ error: "Goal not found" });

  goal.schedule = {
    daily_minutes: Number(answers[0]),   // ✅ updated + safer type
    preferred_time: answers[1],
    consistency: answers[2]
  };

  res.json({ message: "Schedule saved" });
});

// ================= PLAN =================
app.post("/generate-plan", async (req, res) => {
  if (!session.goals.length) {
    return res.status(400).json({ error: "No goals found" });
  }

  const language = session.onboarding?.language || "English";

  const onboarding = `
User:
- Name: ${session.onboarding?.name || "User"}
- Free time: ${session.onboarding?.free_time || "Unknown"} hours
- Language: ${language}
`;

  const goalsContext = session.goals.map(g => {
    const repeatNote = g.repeatNextDay
      ? "IMPORTANT: User missed previous task. Repeat a simpler version."
      : "User completed previous task normally.";

    return `
Goal: ${g.title}

User Context:
- Activity Level: ${g.context?.activity_level || "Unknown"}
- Comfort Level: ${g.context?.comfort_level || "Unknown"}
- Fitness Level: ${g.context?.fitness_level || "Beginner"}

Schedule:
- Daily Time Available: ${g.schedule?.daily_minutes || 20} minutes
- Preferred Time: ${g.schedule?.preferred_time || "Any"}
- Weekly Consistency: ${g.schedule?.consistency || "3–4 days"}

Performance:
- ${repeatNote}
- Adjustment: ${g.lastEvaluation?.adjustment || "same"}
`;
  }).join("\n");

  const prompt = `
${onboarding}

${goalsContext}

Target Audience:
Older men (40+), beginners, low stamina, starting from scratch.

Language to respond in: ${language}

Create a DAILY FITNESS plan.

CRITICAL RULES:

1. ALWAYS start small
- Assume user is a beginner
- First tasks must feel easy and achievable

2. STRICT TIME CONTROL
- Each task MUST respect "Daily Time Available"
- Do NOT exceed it

3. INTENSITY LOGIC (VERY IMPORTANT)
Use this strictly:
- If Adjustment = "increase" → slightly increase duration OR effort (not both aggressively)
- If "same" → keep similar structure
- If "decrease" → reduce duration and simplify task
- If "missed" → repeat a lighter version of previous task

4. PROGRESSION STYLE
- Gradual only (5–10% increase max)
- No sudden jumps
- No advanced exercises early

5. TYPE OF ACTIVITIES
- Walking
- Light stretching
- Mobility exercises
- Basic body movements

6. NEVER INCLUDE:
- Running for long durations
- Heavy weights
- High-impact exercises (jumping, sprinting)

7. TASK QUALITY
BAD: "Do exercise"
GOOD: "Walk slowly for 10 minutes + stretch arms and legs for 5 minutes"

8. KEEP LANGUAGE SIMPLE AND FRIENDLY
- Conversational tone
- No technical terms

9. CONSISTENCY RULE:
- If user selected "2–3 days", keep tasks very light and short
- If "3–4 days", maintain moderate progression
- If "5–6 days", allow slightly faster progression

Return JSON:
{
  "daily_tasks": [
    {
      "goal": "",
      "domain": "fitness",
      "task": "",
      "time_minutes": 0,
      "suggested_time": ""
    }
  ]
}
`;

  const ai = await callLLM(prompt);
  const parsed = safeParseJSON(ai);

  if (!parsed || !parsed.daily_tasks) {
    return res.status(500).json({ error: "Plan generation failed" });
  }

  const finalTasks = parsed.daily_tasks.map(task => {
const match =
  session.goals.find(g =>
    task.goal?.toLowerCase().includes(g.title.toLowerCase())
  ) || session.goals[0];    return {
      ...task,
      goalId: match?.id || null
    };
  });

  session.combinedPlan = { daily_tasks: finalTasks };

  // ✅ reset flags for next cycle
  session.goals.forEach(g => {
    g.repeatNextDay = false;
    g.completedToday = false;
  });

  res.json({ plan: session.combinedPlan });
});

// ================= TODAY TASK =================
app.get("/today-task", (req, res) => {
  if (!session.combinedPlan?.daily_tasks?.length) {
    return res.json({ tasks: [] });
  }

  const tasks = session.combinedPlan.daily_tasks.filter(t => {
    const goal = session.goals.find(g => g.id === t.goalId);

    if (!goal) return false; // prevent broken tasks

    return !goal.completedToday;
  });

  res.json({ tasks });
});


// ================= GENERATE REFLECTION =================
app.post("/generate-reflection", async (req, res) => {
  const { goalId } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) {
    return res.status(400).json({ error: "Goal not found" });
  }

  const language = session.onboarding?.language || "English";

  const prompt = `
Language: ${language}

You are asking reflection questions to a beginner fitness user (age 40+).

Generate exactly 2 very simple and clear questions.

GOAL:
- Understand how difficult the task felt
- Understand if they completed it

RULES:
- Keep language extremely simple
- Friendly and conversational tone
- No long sentences
- No technical words

QUESTIONS MUST BE:

1. About difficulty:
   Example: "How did today's activity feel? Easy, okay, or hard?"

2. About completion:
   Example: "Were you able to finish it?"

Return JSON:
{
  "questions": ["...", "..."]
}
`;

  const ai = await callLLM(prompt);
  let parsed = safeParseJSON(ai);

  if (!parsed || !parsed.questions) {
    parsed = {
      questions: [
        "How did today's activity feel? Easy, okay, or hard?",
        "Were you able to finish it?"
      ]
    };
  }

  res.json({ questions: parsed.questions });
});

// ================= MARK INCOMPLETE =================
app.post("/mark-incomplete", (req, res) => {
  const { goalId } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) return res.status(400).json({ error: "Goal not found" });

  goal.repeatNextDay = true;

  // 👇 this is NOT completion, it's just "handled for today"
  goal.completedToday = true;

  // 👇 optional (future-proof)
  goal.lastEvaluation = { adjustment: "decrease" };

  res.json({ message: "Task will repeat tomorrow" });
});

// ================= EVALUATION =================
app.post("/evaluate-day", (req, res) => {
  const { goalId, answers } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) return res.status(400).json({ error: "Goal not found" });

  const difficulty = (answers[0] || "").toLowerCase();
  const completion = (answers[1] || "").toLowerCase();

  let adjustment = "same";

  // 🔥 LOGIC
  if (completion.includes("no")) {
    adjustment = "decrease";
  } else if (difficulty.includes("easy")) {
    adjustment = "increase";
  } else if (difficulty.includes("hard")) {
    adjustment = "decrease";
  } else {
    adjustment = "same";
  }

  goal.lastEvaluation = { adjustment };
  goal.completedToday = true;

  res.json({ adjustment });
});


// ================= START =================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});