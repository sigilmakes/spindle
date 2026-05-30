export const meta = {
  name: "review",
  description: "Quick review of the current codebase",
  whenToUse: "When you need a fast codebase review",
  phases: [{ title: "Scan" }, { title: "Assess" }],
};

phase("Scan");
const inventory = await agent("List the main source modules in this repo and what each does. Be concise.", { label: "scout" });

phase("Assess");
const assessment = await agent("Given this inventory, give a one-paragraph quality assessment:\n" + inventory, { label: "reviewer" });
return assessment;
