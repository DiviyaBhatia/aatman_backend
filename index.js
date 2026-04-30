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
        { role: "system", content: "Return ONLY valid JSON." },
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
  const { name, free_time } = req.body;

  if (!name || !free_time) {
    return res.status(400).json({ error: "Missing onboarding data" });
  }

  session.onboarding = { name, free_time };

  res.json({ message: "Onboarding saved" });
});

// ================= GOALS =================
app.post("/start-goal", (req, res) => {
  const { goal, timeline, domain } = req.body;

  if (!goal || !timeline || !domain) {
    return res.status(400).json({ error: "Missing goal data" });
  }

  const newGoal = {
    id: Date.now(),
    title: goal,
    timeline,
    domain,
    answers: [],
    context: {},
    schedule: {},
    completedToday: false,     // ✅ FIX
    repeatNextDay: false,      // ✅ FIX
    lastEvaluation: null       // ✅ FIX
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

  for (let goal of session.goals) {
    const prompt = `
Goal: ${goal.title}
Domain: ${goal.domain}

Generate 3 SHORT multiple-choice questions.

Purpose:
- Quickly understand the user
- Keep answers fast

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
    purpose: answers[0],
    subject: answers[1],
    level: answers[2]
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

  const isFitness = goal.domain === "fitness";

  // 👇 onboarding preferred time
  const onboardingTime = session.onboarding?.preferred_time || "evening";

  // 👇 time ranges
  const timeRanges = {
    morning: [6, 10],
    afternoon: [12, 16],
    evening: [16, 20],
    night: [20, 24]
  };

  const [start, end] = timeRanges[onboardingTime] || [16, 20];

  // 👇 generate slots
  const timeSlots = [];
  for (let h = start; h < end; h++) {
    timeSlots.push(`${h}:00 - ${h + 1}:00`);
  }

  const questions = [
    {
      type: "number",
      question: "How many hours can you dedicate daily?",
      key: "daily_hours",
      min: 1,
      max: 12,
      default: 2
    },

    ...(isFitness
      ? [
          {
            type: "number",
            question: "How intense should your workout be?",
            key: "intensity",
            min: 1,
            max: 10,
            default: 3
          }
        ]
      : [
          {
            type: "number",
            question: "How many pages or units can you cover in one session?",
            key: "pages_per_session",
            min: 1,
            max: 100,
            default: 10
          }
        ]),

    {
      type: "select",
      question: "When are you usually free?",
      key: "preferred_time",
      options: [...timeSlots, "Other"]
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
    daily_hours: answers[0],     // ✅ FIX
    preferred_time: answers[1]
  };

  res.json({ message: "Schedule saved" });
});

// ================= PLAN =================
app.post("/generate-plan", async (req, res) => {
  if (!session.goals.length) {
    return res.status(400).json({ error: "No goals found" });
  }

  const onboarding = `
User:
- Name: ${session.onboarding?.name || "User"}
- Free time: ${session.onboarding?.free_time || "Unknown"} hours
`;

  const goalsContext = session.goals.map(g => {
    const repeatNote = g.repeatNextDay
      ? "IMPORTANT: repeat or simplify"
      : "normal progress";

    return `
Goal: ${g.title}
Domain: ${g.domain}

Schedule:
- Daily Hours: ${g.schedule?.daily_hours}
- Preferred Time: ${g.schedule?.preferred_time}

Performance:
- ${repeatNote}
- Adjustment: ${g.lastEvaluation?.adjustment || "same"}
`;
  }).join("\n");

 const prompt = `
${onboarding}

${goalsContext}

Create a DAILY plan using SMALL, REALISTIC steps.

CRITICAL RULES:

1. Tasks MUST be beginner-friendly
   - Assume user is just starting
   - No overwhelming tasks
   - No "finish entire topic"

2. Break goals into MICRO STEPS
   - Reading → few pages
   - Learning → one concept
   - Fitness → short session

3. Respect user's daily_hours strictly
   - Total time must NOT exceed available time

4. Progression logic:
   - If adjustment = "increase" → slightly harder
   - If "same" → similar level
   - If "decrease" → simplify task

5. If repeatNextDay was true:
   - Repeat SAME task or make it easier
   - DO NOT introduce new topic

6. Keep tasks CLEAR and SPECIFIC
   BAD: "Study Java"
   GOOD: "Learn variables and practice 5 examples"

7. Time rules:
   - Each task should be 20–90 mins max
   - Suggested_time should match user's preference

Return JSON:
{
  "daily_tasks": [
    {
      "goal": "",
      "domain": "",
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
    const match = session.goals.find(g => g.title === task.goal);
    return {
      ...task,
      goalId: match?.id || null
    };
  });

  session.combinedPlan = { daily_tasks: finalTasks };

  // ✅ RESET FLAGS
  session.goals.forEach(g => {
    g.repeatNextDay = false;
    g.completedToday = false;   // ✅ FIX
  });

  res.json({ plan: session.combinedPlan });
});

// ================= TODAY TASK =================
app.get("/today-task", (req, res) => {
  if (!session.combinedPlan) {
    return res.json({ tasks: [] });
  }

  const tasks = session.combinedPlan.daily_tasks.filter(t => {
    const goal = session.goals.find(g => g.id === t.goalId);
    return !goal?.completedToday;   // ✅ FIX
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

  const prompt = `
Goal: ${goal.title}
Domain: ${goal.domain}

Generate 2 short, simple reflection questions.

Rules:
- Keep them easy to answer
- No long explanations
- Focus on effort, not perfection

If learning:
- Ask what they understood
- Ask what they found difficult

If fitness:
- Ask how hard it felt
- Ask if they could complete it

Return JSON:
{
  "questions": ["", ""]
}
`;

  const ai = await callLLM(prompt);
  const parsed = safeParseJSON(ai);

  if (!parsed || !parsed.questions) {
    return res.status(500).json({ error: "Reflection generation failed" });
  }

  res.json({ questions: parsed.questions });
});

// ================= MARK INCOMPLETE =================
app.post("/mark-incomplete", (req, res) => {
  const { goalId } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) return res.status(400).json({ error: "Goal not found" });

  goal.repeatNextDay = true;
  goal.completedToday = true;   // ✅ FIX (remove from today)

  res.json({ message: "Task will repeat tomorrow" });
});

// ================= EVALUATION =================
app.post("/evaluate-day", async (req, res) => {
  const { goalId, answers } = req.body;

  const goal = session.goals.find(g => g.id === Number(goalId));
  if (!goal) return res.status(400).json({ error: "Goal not found" });

  const prompt = `
User answers:
${answers.join("\n")}

Evaluate performance.

Return JSON:
{
  "adjustment": "increase" | "decrease" | "same"
}
`;

  const ai = await callLLM(prompt);
  const parsed = safeParseJSON(ai);

  goal.lastEvaluation = parsed;   // ✅ FIX
  goal.completedToday = true;     // ✅ FIX

  res.json(parsed);
});

// ================= START =================
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});