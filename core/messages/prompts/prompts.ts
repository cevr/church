export const userRevisePrompt = (
  prompt: string,
  outline: string,
  revisions: string,
) => `
Please revise the following Sabbath message to be inline with the aforementioned criteria.

- IMPORTANT: Only return the revised outline, nothing else.

${prompt ? `original prompt:\n${prompt}` : ''}

original outline:
${outline}

Revisions:
${revisions}
`;
