# Comments: self-documenting code first

Applies whenever you write, modify, or refactor code in this repository.

## The default is no comment

Code communicates intent through names, function boundaries, explicit parameters and
return values, straightforward control flow, and well-chosen abstractions. Before writing
a comment, ask whether clearer code would remove the need for it. If it would, write the
clearer code instead.

A few high-value comments beat many that repeat what the code already says. When in doubt,
leave the comment out.

## Never narrate the implementation

A comment restating what the next line does is noise, and it rots the moment the line
changes:

```ts
// Get the user
const user = getUser(id);

// Check if user exists
if (user) { … }

// Increment counter
counter++;
```

None of those earn their place. Delete them.

## Never use a comment instead of a name

Extract a named constant, variable, or predicate function.

```ts
// Bad — the comment carries meaning the code should
// Calculate the number of active users
const x = users.filter(u => u.active).length;

// Good
const activeUserCount = users.filter(user => user.active).length;
```

```ts
// Bad
// Customers over 65 who are members receive a discount
const condition = customer.age >= 65 && customer.isMember;

// Good
const isEligibleForDiscount = customer.age >= 65 && customer.isMember;
```

```ts
// Bad
// Check whether the user may access the resource
if (user.role === "admin" || user.id === resource.ownerId) { … }

// Good
if (canAccessResource(user, resource)) { … }
```

If a block needs a comment to explain *what* it does, that is a signal to extract it into a
well-named function rather than to describe it in prose.

## When a comment IS warranted

Only for information the code cannot carry itself — all of these are "why", never "what":

1. **Non-obvious business logic.** Why a rule exists, when the reason is not evident from
   the code.
2. **External constraints.** A workaround, a platform limitation, a framework quirk, an
   API that behaves differently from its documentation.
3. **Non-trivial algorithms or formulas.** The underlying idea, concisely. If it comes from
   a paper, spec, RFC, or issue, link it.
4. **Deliberate oddity.** Code that looks suspicious or counterintuitive but is correct —
   say why, and why the obvious alternative would be wrong.
5. **Invariants and assumptions** the types cannot express.

Prefer explaining why this approach was chosen, why a simpler one would be incorrect, what
external constraint applies, what invariant must hold, or where a formula came from.

## Before finalising a comment

Check each one:

1. Is this already obvious from the code?
2. Would a better name make it unnecessary?
3. Would a small extraction make it unnecessary?
4. Does it explain **why** rather than **what**?
5. Will it still be true and useful to someone else in six months?

If it fails any of these, fix the code and drop the comment.

## What this rule does not target

Section labels inside long literal tables — a sixty-entry list of regexes or a language
table — are navigation, not narration. They stay.
