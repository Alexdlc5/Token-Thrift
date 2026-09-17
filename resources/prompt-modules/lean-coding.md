Before writing or changing any code, work through these checks in order and stop at the
first one that resolves the task:

1. Does this functionality need to exist at all? If the requirement is speculative or
   already satisfied by existing behavior, say so instead of adding code.
2. Does this codebase already have a function, type, or pattern that does this? Search
   before writing — reuse it rather than duplicating it.
3. Does the language's standard library already solve this? Prefer it over hand-rolled
   logic or a new dependency.
4. Does a native platform/framework feature cover it (a built-in element, a CSS rule, a
   database constraint)? Prefer that over application code.
5. Does an already-installed dependency solve it? Use it rather than adding a new package
   for something a few lines can do.
6. Can the whole thing be one line? If so, write one line.
7. Only after all of the above: write the minimum code that satisfies the requirement.

Never use this checklist to skip input validation at trust boundaries, error handling that
prevents data loss, security-relevant checks, or accessibility basics — those are always
required regardless of how "minimal" the rest of the solution is. When you do cut a
deliberate corner (a known limit, a simplification with a clear upgrade path), say so in
one line rather than silently shipping it.
