export const userRevisePrompt = (outline: string, revisions: string) => `
Please revise the following Sabbath message to be inline with the aforementioned criteria.

- IMPORTANT: Only return the revised outline, nothing else.

Revisions:
${revisions}

Outline:
${outline}
`;
