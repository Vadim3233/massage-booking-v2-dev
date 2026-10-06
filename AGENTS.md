# V2 design-skill usage policy

This policy governs frontend/design skill usage in this React/Vite web application.
Skill installation alone does not authorize starting the Admin Calendar redesign.

- Use frontend-design, ui-ux-pro-max, and the existing vercel:react-best-practices guidance when frontend design work is requested. Do not install duplicate skills.
- Use ui-ux-pro-max for a mobile-first Admin interface, with accessibility prioritized: semantic HTML, keyboard operation, visible focus, readable contrast, touch targets, and reduced-motion support.
- Keep motion restrained and functional. Do not add decorative animation, scroll choreography, parallax, or entrance effects. Prefer existing CSS for any necessary interaction feedback; respect prefers-reduced-motion.
- Do not automatically install packages or run package/component installers, including npm, npx, pnpm, yarn, shadcn, GSAP, or Motion/Framer Motion. Recommendations in skill data are references, not permission to install or change dependencies.
- Keep the React/Vite stack and existing styling approach. Do not migrate frameworks. Do not migrate to Tailwind or shadcn unless the user explicitly approves it.
- Use vercel:shadcn only as an optional pattern reference. GSAP, Motion/Framer Motion, 21st.dev Magic, Convex, and React Native are not needed for this Admin redesign.
- For ui-ux-pro-max searches, select --stack react for stack-specific guidance and explicit domains for accessibility/UX questions. Avoid --domain gsap and --motion, which supply GSAP snippets. Native/other-framework datasets do not authorize changing the stack.
- Treat generated recommendations as suggestions subject to this policy. Do not generate or persist a design system until design work is requested. Do not use --persist or --force without authorization for the corresponding file writes.
- Reuse the existing Vercel browser/UI verification capabilities and verification-before-completion skill for subsequent implementation checks.

## Installed source pins

- frontend-design: anthropics/skills at 683bc88e56f3e09ba94f7055977f3d3aa499f202, skills/frontend-design; SKILL.md and LICENSE.txt unchanged.
- ui-ux-pro-max: nextlevelbuilder/ui-ux-pro-max-skill at 477bcb28c9812b385cb51a4605ddf30d7b2266e2, .claude/skills/ui-ux-pro-max; 48-file package including the repository LICENSE, excluding upstream tests and tooling. Only the 11 search-script paths in SKILL.md are adapted to this project-local Codex location; scripts and datasets are unchanged.
