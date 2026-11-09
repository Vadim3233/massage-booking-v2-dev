# V2 design-skill usage policy

This policy governs frontend/design skill usage in this React/Vite web application.
Skill installation alone does not authorize starting the Admin Calendar redesign.

- Use frontend-design, ui-ux-pro-max, and the existing vercel:react-best-practices guidance when frontend design work is requested. Do not install duplicate skills.
- Use ui-ux-pro-max for a mobile-first Admin interface, with accessibility prioritized: semantic HTML, keyboard operation, visible focus, readable contrast, touch targets, and reduced-motion support.
- Motion (owner's decision, 2026-11-08): in the client booking flow, small CSS-only animations are welcome, including gentle entrance effects, a rolling price and a drawn success tick. Each must last 0.4 s or less, must never delay or block a tap, and must be switched off under prefers-reduced-motion. No scroll choreography or parallax. The Admin stays calm and functional: interaction feedback only. Never add an animation library for this (see the next rule).
- Do not automatically install packages or run package/component installers, including npm, npx, pnpm, yarn, shadcn, GSAP, or Motion/Framer Motion. Recommendations in skill data are references, not permission to install or change dependencies.
- Keep the React/Vite stack and existing styling approach. Do not migrate frameworks. Do not migrate to Tailwind or shadcn unless the user explicitly approves it.
- Use vercel:shadcn only as an optional pattern reference. GSAP, Motion/Framer Motion, 21st.dev Magic, Convex, and React Native are not needed for this Admin redesign.
- For ui-ux-pro-max searches, select --stack react for stack-specific guidance and explicit domains for accessibility/UX questions. Avoid --domain gsap and --motion, which supply GSAP snippets. Native/other-framework datasets do not authorize changing the stack.
- Treat generated recommendations as suggestions subject to this policy. Do not generate or persist a design system until design work is requested. Do not use --persist or --force without authorization for the corresponding file writes.
- Reuse the existing Vercel browser/UI verification capabilities and verification-before-completion skill for subsequent implementation checks.

## Installed source pins

- frontend-design: anthropics/skills at 683bc88e56f3e09ba94f7055977f3d3aa499f202, skills/frontend-design; SKILL.md and LICENSE.txt unchanged.
- ui-ux-pro-max: nextlevelbuilder/ui-ux-pro-max-skill at 477bcb28c9812b385cb51a4605ddf30d7b2266e2, .claude/skills/ui-ux-pro-max; 48-file package including the repository LICENSE, excluding upstream tests and tooling. Only the 11 search-script paths in SKILL.md are adapted to this project-local Codex location; scripts and datasets are unchanged.

# Keep the FAQ and Help up to date (owner's rule, 2026-11-09)

The client FAQ (`/faq`, content in `src/client/faq/faqContent.js`) and the Admin Help page (More › Help, content in `src/admin/helpContent.js`) must always describe what the app does today.

- Whenever a change adds, removes or changes something a client or the Admin can see or do, update the matching answer (or add a new question) in the same pull request, and say so in the PR description.
- If you are not sure the change belongs in the FAQ, ask Vadim in plain words: "Shall I add this to the FAQ: '<question>'?"
- Policy answers (refunds, missed appointments, what to prepare at home, contact) are Vadim's words only. Never invent them.
- Numbers that live in settings (booking rules, areas, fees) are read live, never typed into the answers.
