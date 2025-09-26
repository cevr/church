export const userRevisePrompt = (
  prompt: string,
  study: string,
  revisions: string,
) => `
Please revise the following bible study to be inline with the aforementioned criteria.
- IMPORTANT: Only return the revised study, nothing else.

${prompt ? `original prompt:\n${prompt}` : ''}

original study:
${study}

Revisions:
${revisions}
`;
