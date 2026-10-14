/**
 * Grades one finished task: did the agent do what was asked?
 *
 *   const grade = await gradeTask(task, trajectory)   → { verdict: "pass" | "fail" | "impossible", reasoning }
 *
 * The judging instructions are BU Bench's, as ported in Aside's runner
 * (github.com/at-inc/aside-benchmarks, MIT): the task, its ground truth
 * when it has one, and the agent's trajectory go to a model, which answers
 * with a JSON verdict. Aside's runner judges with gemini-2.5-flash; we use
 * the same model as the agent (model.ts), the only one we have here.
 *
 * Uses:    model.ts
 * Used by: run.ts
 */
import { ask } from "./model.ts"

export interface BenchTask {
  task_id: string
  confirmed_task: string
  category: string
  answer?: string
}

export interface Grade {
  verdict: "pass" | "fail" | "impossible" | "error"
  reasoning: string
}

/** Each side of a long trajectory is kept up to this length; the middle is cut. */
const SIDE_CHARS = 40_000

export async function gradeTask(task: BenchTask, trajectory: string): Promise<Grade> {
  const { systemPrompt, userPrompt } = judgePrompts(task, trajectory)
  let lastError = ""
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await ask({
        systemPrompt,
        messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
      })
      const text = reply.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
      const judged = JSON.parse(json) as {
        reasoning?: string
        verdict: boolean
        failure_reason?: string
        impossible_task?: boolean
      }
      let verdict: Grade["verdict"] = "fail"
      if (judged.verdict) {
        verdict = "pass"
      } else if (judged.impossible_task) {
        verdict = "impossible"
      }
      const reasoning = [judged.reasoning, judged.failure_reason].filter(Boolean).join("\n\nFailure reason: ")
      return { verdict, reasoning }
    } catch (caught) {
      lastError = caught instanceof Error ? caught.message : String(caught)
    }
  }
  return { verdict: "error", reasoning: `Grader error: ${lastError}` }
}

function cutMiddle(text: string): string {
  if (text.length <= SIDE_CHARS * 2) {
    return text
  }
  const cut = text.length - SIDE_CHARS * 2
  return `${text.slice(0, SIDE_CHARS)}\n[...${cut} characters cut - agent did actions but truncated...]\n${text.slice(-SIDE_CHARS)}`
}

function judgePrompts(task: BenchTask, trajectory: string): { systemPrompt: string; userPrompt: string } {
  let groundTruthSection = ""
  if (task.answer) {
    groundTruthSection = `
**GROUND TRUTH VALIDATION (HIGHEST PRIORITY):**
The <ground_truth> section contains verified correct information for this task. This can be:
- **Evaluation criteria**: Specific conditions that must be met
- **Factual answers**: The correct answer to a question or information retrieval task
- **Expected outcomes**: What should happen after task completion

The ground truth takes ABSOLUTE precedence over all other evaluation criteria. If the ground truth is not satisfied by the agent's execution and final response, the verdict MUST be false.
`
  }

  const systemPrompt = `You are an expert judge evaluating browser automation agent performance.

<evaluation_framework>
${groundTruthSection}
**PRIMARY EVALUATION CRITERIA (in order of importance):**
1. **Task Satisfaction (Most Important)**: Did the agent accomplish what the user asked for?
2. **Output Quality**: Is the final result in the correct format and complete?
3. **Tool Effectiveness**: Did the browser interactions work as expected?
4. **Agent Reasoning**: Quality of decision-making, planning, and problem-solving.
5. **Browser Handling**: Navigation stability, error recovery, and technical execution.

**VERDICT GUIDELINES:**
- true: Task completed as requested, human-like execution, all user criteria were met, and the agent did not make up information.
- false: Task not completed, or only partially completed.

**FAILURE CONDITIONS (automatically set verdict to false):**
- Blocked by captcha or missing authentication
- Output format completely wrong or missing
- Infinite loops or severe technical failures
- Critical user requirements ignored
- Page not loaded
- Browser crashed
- Agent could not interact with required UI elements
- The agent calls done action before completing all key points of the task

**IMPOSSIBLE TASK DETECTION:**
Set \`impossible_task\` to true when the task fundamentally could not be completed due to ambiguous instructions, broken/inaccessible pages, required authentication without credentials, missing site functionality, or other insurmountable external obstacles.

Do NOT mark as impossible if the agent made poor decisions but the task was achievable.

**IMPORTANT EVALUATION NOTES:**
- Evaluate whether attempted actions actually happened.
- Be initially doubtful of the agent's self-reported success.
- This harness provides the agent's actions and the start of each page it read, not screenshots. Do not penalize missing screenshots by itself.

</evaluation_framework>

<response_format>
Respond with EXACTLY this JSON structure (no additional text before or after):

{
  "reasoning": "Detailed analysis of task satisfaction, trajectory quality, tool usage, output quality, and overall user satisfaction prediction.",
  "verdict": true or false,
  "failure_reason": "Max 5 sentences explanation of why the task was not completed successfully in case of failure. If verdict is true, use an empty string.",
  "impossible_task": true or false,
  "reached_captcha": true or false
}
</response_format>`

  let groundTruth = ""
  if (task.answer) {
    groundTruth = `\n<ground_truth>\n${task.answer}\n</ground_truth>\n`
  }
  const userPrompt = `
<task>
${cutMiddle(task.confirmed_task)}
</task>
${groundTruth}
<agent_trajectory>
${cutMiddle(trajectory)}
</agent_trajectory>

Evaluate this agent execution given the criteria and respond with the exact JSON structure requested.`

  return { systemPrompt, userPrompt }
}
