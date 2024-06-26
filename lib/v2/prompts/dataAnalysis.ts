import { ChatGPTMessage } from "../../models";
import { Action, Organization } from "../../types";
import { getIntroText } from "../../prompts/chatBot";
import { getActionTSSignature } from "../../prompts/tsConversion";
import { snakeToCamel } from "../../utils";

export const GPTDataAnalysisLLMParams = {
  max_tokens: 800,
  stop: [],
};

export function getOpusOrGPTDataAnalysisPrompt(args: {
  question: string;
  selectedActions: Action[];
  orgInfo: Pick<Organization, "name" | "description" | "chatbot_instructions">;
  userDescription: string;
}): ChatGPTMessage[] {
  const actionTS = args.selectedActions.map((action) => {
    return getActionTSSignature(action, true, null, true);
  });
  return [
    {
      role: "system",
      content: `${getIntroText(
        args.orgInfo,
      )} Your task is to help the user by writing a Javascript snippet to call ${
        args.orgInfo.name + "'s" || "the"
      } API which can then be visualized to answer the user's question. Plot data to give a complete picture when possible.
${args.userDescription ? `\nUser description: ${args.userDescription}\n` : ""}${
        args.orgInfo.description ? "\n" + args.orgInfo.description + "\n" : ""
      }${
        args.orgInfo.chatbot_instructions
          ? "\n" + args.orgInfo.chatbot_instructions + "\n"
          : ""
      }
FUNCTIONS
\`\`\`
${actionTS.join("\n\n")}

/** Plots data for the user. Users can toggle to view data in a table. DO NOT call plot() more than two times **/
function plot(title: string,
type: "line"|"bar"|"table",
data: {x:number|string,y:number,[key:string]:any;}[], // Max length: 25 (100 if a line chart). The wildcard is to add extra information shown in the table and when hovering the data point
labels: {x:string,y:string} // Include axis units in brackets. Example: Conversion rate (%)
)
\`\`\`

Today's date is ${new Date().toISOString().split("T")[0]}

RULES:
1. ONLY use the standard JS library and FUNCTIONS. DO NOT use other libraries or frameworks. THIS IS VERY IMPORTANT!
2. NEVER write TODO comments, placeholder code or ... in place of code
3. The following cause runtime errors: fetch() (or calling another server), eval(), new Function(), WebAssembly, try-catch, TS types and function definitions
4. DO NOT use return to send data to the user. Use plot() to display data or console.log() to output text. To list data, plot a table
5. Use await NOT .then()
6. DO NOT call FUNCTIONS in a loop, UNLESS wrapped by Promise.all() or the loop is 5 or less. THIS IS VERY IMPORTANT!
7. When calculating cumulative values, ORDER THE DATA first!
8. Respond with your plan, followed by code enclosed by \`\`\` like below:
"""
Plan:
1. Think
2. step-by-step

\`\`\`
// Write code here
\`\`\`
"""`,
    },
    { role: "user", content: args.question },
  ];
}

export function parseOpusOrGPTDataAnalysis(
  output: string,
  actions: Pick<Action, "name">[],
): { code: string } | { error: string } | null {
  /** Code output means the code is valid
   * Error output is an error message to be shown to the AI
   * null output means that you need to retry **/
  const match = output.match(
    /^(```jsx?|```javascript|\(?async |function |const |let |var |\/\/ )/m,
  );
  if (!match) {
    console.error(
      "Couldn't find the start of the code:\n---\n" + output + "\n---",
    );
    return null;
  }
  // Remove everything before the first code block (incl the code block opener if there is one)
  let rawCode = output
    .slice(match.index)
    .replace(/^(```jsx?|```javascript)/, "");
  // Find the next end of code
  rawCode = rawCode.split("```")[0];
  // Remove the plan if there is one
  rawCode = rawCode.replace(/Plan:\s?(\n\d\. .*)+/, "");

  return parseGeneratedCode(rawCode, actions);
}

export function parseGeneratedCode(
  rawCode: string,
  actions: Pick<Action, "name">[],
): { code: string } | { error: string } | null {
  /** Code output means the code is valid
   * Error output is an error message to be shown to the AI
   * null output means that you need to retry **/
  // Check if it's just an error
  const errorMatch = /^\n?throw new Error\((.*)\);?$/.exec(rawCode);
  if (errorMatch) {
    // slice(1, -1) removes the quotes from the error message
    return { error: errorMatch[1].slice(1, -1) };
  }

  // Remove comments (stops false positives from comments containing illegal stuff) & convert from TS to JS
  let code = stripBasicTypescriptTypes(
    rawCode
      .replace(/^\s*(\/\/.*|\/\*([^*]|[\r\n]|(\*+([^*/]|[\r\n])))*\*+\/)/gm, "")
      .trim(),
  );
  if (code === "") {
    console.error("ERROR: No code (possibly comments) in code string");
    return null;
  }

  // Check that fetch(), eval(), new Function() and WebAssembly aren't used
  const illegalRegexes = [
    /fetch\([\w\W]*\)/g,
    /eval\([\w\W]*\)/g,
    /new Function\([\w\W]*\)/g,
    /WebAssembly\./g,
  ];
  for (const regex of illegalRegexes) {
    if (regex.test(code)) {
      const error = `ERROR: Illegal code found by ${String(
        regex,
      )}:\n---\n${code}\n---`;
      console.error(error);
      return null;
    }
  }

  // Check that awaited functions are either defined here, action functions or Promise.all
  const actionNames = actions.map((a) => snakeToCamel(a.name));
  let awaitableActionNames = ["Promise.all", ...actionNames];
  const definedFnNames =
    code
      .match(/(async function (\w+)\(|(const|let|var) (\w+)\s*=\s*async\s*\()/g)
      ?.map((fnNameMatch) => {
        if (fnNameMatch.startsWith("async")) {
          // async function (\w+)\(
          return fnNameMatch.slice(15, -1);
        } else {
          // (const|let|var) (\w+)\s*=\s*async\s*\(
          return fnNameMatch.split("=")[0].split(" ")[1].trim();
        }
      }) ?? [];

  // These are all valid await-able function names
  awaitableActionNames = awaitableActionNames.concat(definedFnNames);

  // Now, get the awaited function names
  const awaitedFns = code.match(/await \S+?\(/g) ?? [];
  for (let fnMatch of awaitedFns) {
    const fnName = fnMatch.slice(6, -1);
    if (!awaitableActionNames.includes(fnName)) {
      const errorMsg = `ERROR parsing data analysis output: Function with name ${fnName} is awaited, yet is not defined or an action name`;
      console.error(errorMsg);
      return null;
    }
  }

  // Code edits (adding awaits where necessary) below here:

  // Whole thing is an unwrapped unnamed function
  const unwrappedUnnamedFn = code.match(
    /^async\s*(\([^)]*\)\s*=>|function\([^)]*\))\s?\{([\s\S]+?)}$/g,
  );
  // Wrap & await it
  if (unwrappedUnnamedFn) code = `await (${code})();`;

  // Sometimes the code is wrapped in an async function which is instantly called, so await this
  const wrappedFn = code.match(
    /(?<!await )\(async\s*(\([^)]*\)\s*=>|function\([^)]*\))\s?\{([\s\S]+)}\n?\s*\)\(\);/g,
  );
  wrappedFn?.forEach((instantCalledCode) => {
    code = code.replace(instantCalledCode, `await ${instantCalledCode}`);
  });

  // The code can be wrapped in a named function which is called later (or not)
  let namedFnContents = code.match(
    // await is optional as is variable setting
    /async function (\w+)\([^)]*\)\s*\{([\s\S]+?)\n}[\S\s]*?(\n\1\([^)]*?\);?)/,
  );
  let i = 0;
  while (namedFnContents && i < 4) {
    i++;
    code = code.replace(
      namedFnContents[3],
      `\nawait ${namedFnContents[3].trim()}`,
    );
    namedFnContents = code.match(
      // await is optional as is variable setting
      /async function (\w+)\([^)]*\)\s*\{([\s\S]+?)\n}[\S\s]*?\n(\1\([^)]*?\);?)/,
    );
  }

  // Unnamed function used as a variable called without await
  const unnamedFnVar = code.match(
    /(const|let|var) (\w+)\s*=\s*async\s*\([^)]*\)\s*=>\s*\{([\s\S]+?)\n};?\s*(\n\2\(\);?)?/,
  );
  if (unnamedFnVar) {
    code = code.replace(unnamedFnVar[4], `await ${unnamedFnVar[4]}`);
  }

  // Rare: API function called with then without await
  actionNames.forEach((actionName) => {
    const thenCall = new RegExp(
      // Capture group enclosing actionName until the end is used as $1 below
      `(?<!await )(${actionName}\\([^)]*\\)\\.(then|catch)\\()`,
    );
    if (thenCall.test(code)) code = code.replace(thenCall, `await $1`);
  });

  // Using TS notation ! or ? in code (or strings - we cut these out too, but not a big issue)
  code = code.replace(/([\w_)\]])!([.)}\[\]\s])/g, "$1$2");
  code = code.replace(/([\w_)\]])\?([.\[])/g, "$1$2");

  return { code };
}

export function stripBasicTypescriptTypes(
  jsCodeString: string,
  definedTypeNames?: string[],
): string {
  /** Remove type definitions like `: string`, `: number`, `: any` etc. **/
  definedTypeNames = definedTypeNames ?? [];

  // Remove interface definitions
  const interfaces = jsCodeString.match(
    /(?:export )?interface\s+(\w+)\s*\{[^}]+}/g,
  );
  if (interfaces) {
    definedTypeNames.push(
      // ...interfaces.map((i) => i.match(/(?:export )?interface\s+(\w+)/)[1]),
      ...interfaces.map((i) => i.match(/(?:export )?interface\s+(\w+)/)![1]),
    );
  }
  jsCodeString = jsCodeString.replace(
    /(?:export )?interface\s+(\w+)\s*\{[^}]+}/g,
    "",
  );

  // Remove type definitions
  const types = jsCodeString.match(/(?:export )?type\s*(\w+)\s*=\s*\w+;?/g);
  if (types) {
    definedTypeNames.push(
      // ...types.map((i) => i.match(/(?:export )?type\s*(\w+)\s*=\s*\w+;?/)[1]),
      ...types.map((i) => i.match(/(?:export )?type\s*(\w+)\s*=\s*\w+;?/)![1]),
    );
  }
  jsCodeString = jsCodeString.replace(/(export )?type\s*\w+\s*=\s*\w+;?/g, "");

  jsCodeString = jsCodeString.replace(
    new RegExp(
      `: (${
        definedTypeNames.length > 0
          ? definedTypeNames
              .map((t) => t.replace(/([\[|(){])/g, "\\$1") + "\\b")
              .join("|") + "|"
          : ""
      }any\[]|string\[]|number\[]|null\[]|boolean\[]|object\[]|any|string|number|null|boolean|object|Record<string,\s*(any|string|number|null|boolean|object)>)(\[])?`,
      "g",
    ),
    "",
  );

  return jsCodeString;
}

export function shouldTerminateDataAnalysisStreaming(
  streamedText: string,
): boolean {
  /** It's common for LLMs to write text after the code to explain it. I think they've been
   * fine-tuned to do this. A way to deal with this is to stream the response and stop
   * when it outputs a 2nd ``` which signifies the end of the code **/
  const match = streamedText.match(
    /^(```jsx?|```javascript|\(?async |function |const |let |var |\/\/ )/m,
  );
  if (!match) return false;

  // Remove everything before the first code block (incl the code block opener if there is one)
  let rawCode = streamedText
    .slice(match.index)
    .replace(/^(```jsx?|```javascript)/, "");

  // If there's a 2nd code block to close the first, then we're done
  const out = Boolean(rawCode.match(/^```/m));
  if (out) console.log("\nTerminating streaming now");
  return out;
}
