// Markdown escaping shared by classify.js and report.js. Site-supplied text goes through code().
export const code = (s) => `\`${String(s).replaceAll('`', '%60')}\``;
export const cell = (s) => String(s).replaceAll('|', '\\|');
