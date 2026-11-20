# Debugging tips, contact and skills (reference)

## Debugging Tips

**Check Prisma Schema:**
```bash
npx prisma studio    # Visual DB explorer on localhost:5555
npx prisma db pull   # Sync schema from database
```

**Debug Server Actions:**
- Add console.log statements (visible in server logs)
- Check NextAuth session: `const session = await requireAuth()`
- Verify role permissions: `hasPermission(session.user.role, 'permission')`
- Check activity log for errors: `app/(dashboard)/activity/`

**Debug Database Queries:**
- Enable Prisma debug logs: `DEBUG="prisma:*" npm run dev`
- Use Prisma Studio to inspect data

**Debug Integrations:**
- WooCommerce: Check sync job logs in `app/(dashboard)/sync/`
- Xero: Check sync status and journal entries in `app/(dashboard)/sync/`
- Check email delivery in SMTP logs or notification history

**Check Environment Variables:**
- Verify `.env` file exists and is not in `.gitignore`
- Never commit secrets; use `.env.example` as template
- Check `NEXT_PUBLIC_*` variables don't contain secrets

**TypeScript Errors:**
```bash
npm run type-check    # Full TypeScript check across entire project
npm run lint          # ESLint style and quality checks
```

## Contact & Support

- **Product Owner:** One Two Enterprises Ltd
- **Repository:** git@github.com:OneTwo3D/IMS.git
- **Issues:** Document in activity log + GitHub issues
- **Questions:** Reference docs first, then contact dev team
- **Reporting Bugs:** Include relevant activity log entries and environment details


## Skill Usage Guide

When working on tasks involving these technologies, invoke the corresponding skill:

| Skill | Use When |
|-------|----------|
| typescript | Enforcing TypeScript strict mode with type safety across all code |
| node | Executing JavaScript on server with Node.js runtime |
| react | Managing React components, hooks, and client-side state patterns |
| postgresql | Managing PostgreSQL schemas and database migrations |
| prisma | Accessing databases with type-safe Prisma ORM queries |
| tailwind | Applying utility-first CSS styling with Tailwind CSS 4.x |
| zod | Validating input data with Zod schema definitions |
| nextauth | Implementing authentication with NextAuth.js sessions and RBAC |
| shadcn-ui | Implementing accessible UI components from Shadcn/UI library |
| frontend-design | Designing UI with Tailwind CSS, components, and accessibility patterns |
| nodemailer | Sending SMTP emails through Nodemailer integration |
| nextjs | Building full-stack apps with App Router and Server Components |
| designing-onboarding-paths | Designing onboarding paths, checklists, and first-run UI |
| writing-release-notes | Drafting release notes tied to shipped features |
| designing-inapp-guidance | Building tooltips, tours, and contextual guidance |
| eslint | Enforcing code quality with ESLint configuration |
| orchestrating-feature-adoption | Planning feature discovery, nudges, and adoption flows |
| structuring-offer-ladders | Framing plan tiers, value ladders, and upgrade logic |
| framing-release-stories | Building launch narratives, assets, and rollout checklists |
| mapping-user-journeys | Mapping in-app journeys and identifying friction points in code |
| streamlining-signup-steps | Reducing friction in signup and trial activation flows |
| accelerating-first-run | Improving onboarding sequence and time-to-value |
| tuning-landing-journeys | Improving landing page flow, hierarchy, and conversion paths |
| inspecting-search-coverage | Auditing technical and on-page search coverage |
| adding-structured-signals | Adding structured data for rich results |
| pdfkit | Generating branded PDF documents with PDFKit for invoices and reports |
| crafting-page-messaging | Writing conversion-focused messaging for pages and key CTAs |
| instrumenting-product-metrics | Defining product events, funnels, and activation metrics |


