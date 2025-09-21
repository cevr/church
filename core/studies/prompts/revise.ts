export const userRevisePrompt = (study: string, revisions: string) => `
Please revise the following bible study to be inline with the aforementioned criteria.

- IMPORTANT: Only return the revised study, nothing else.

Revisions:
${revisions}

Study:
${study}
`;
