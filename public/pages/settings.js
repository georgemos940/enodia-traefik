// Placeholder until this page is built.
import { empty } from '../lib/components.js';
export default { render(ctx) { ctx.setCrumbs([[ctx.page.title]]); return { el: empty(ctx.page.title, 'This page is being built.', 'layers') }; } };
