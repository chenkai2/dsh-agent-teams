import test from 'node:test'
import assert from 'node:assert/strict'
import { memberDenyList, restrictMemberTools, startMemberWithLenientFilter } from '../lib/members.js'
import { CAPTAIN_TOOL_NAMES } from '../lib/tool-names.js'

/**
 * `dsh-web-app` and the Agent Teams profile layer ship `tool-subagent` and
 * `tool-subagent-control` disabled, so `subagent` and `send_message` are absent from the
 * registry. The host applies a member's `toolFilter` and the member capability restriction
 * through the same strict `tools.restrict()`, which rejects an unregistered name instead of
 * ignoring it. That rejection used to abort every member start, leaving every member of every
 * team `unspawned` with no visible reason.
 *
 * The host message shape is reproduced verbatim so the contract stays pinned to it:
 * `tools.restrict() names unknown global tool "x"; known global tools: …`.
 */
const hostRejection = names => new Error(
  `tools.restrict() names unknown global tool${names.length > 1 ? 's' : ''} ${names.map(name => `"${name}"`).join(', ')}; known global tools: (none)`,
)

test('a member deny list never names a host tool the composition does not register', async t => {
  // The plugin registers its own tools in the global layer, so a captain's view resolves
  // them; the host controls are only resolved when their rows are enabled.
  const view = names => ({ id: 'captain', ctx: { tools: { get: name => (names.includes(name) ? {} : undefined) } } })
  const captains = {
    withHostTools: view([...CAPTAIN_TOOL_NAMES, 'subagent', 'send_message']),
    withoutHostTools: view([...CAPTAIN_TOOL_NAMES]),
    uninspectable: { id: 'captain' },
  }

  await t.test('registered host controls stay denied', () => {
    assert.deepEqual(memberDenyList(captains.withHostTools, 0), [...CAPTAIN_TOOL_NAMES, 'subagent', 'send_message'])
  })

  await t.test('absent host controls are dropped, the plugin tools stay', () => {
    assert.deepEqual(memberDenyList(captains.withoutHostTools, 0), [...CAPTAIN_TOOL_NAMES])
  })

  await t.test('an uninspectable captain keeps the intended list', () => {
    // The lenient capability restrict and the start retry still guarantee the member starts.
    const deny = memberDenyList(captains.uninspectable, 0)
    assert.ok(deny.includes('subagent') && deny.includes('send_message'))
  })

  await t.test('a delegation cap above zero never denies the host controls', () => {
    assert.deepEqual(memberDenyList(captains.withHostTools, 1), [...CAPTAIN_TOOL_NAMES])
  })
})

test('a member start retries without the names the host rejects', async t => {
  await t.test('the rejected names are removed and the start succeeds', async () => {
    const attempts = []
    const result = await startMemberWithLenientFilter(async deny => {
      attempts.push([...deny])
      if (attempts.length === 1) throw hostRejection(['subagent', 'send_message'])
      return { childId: 'child' }
    }, [...CAPTAIN_TOOL_NAMES, 'subagent', 'send_message'])
    assert.deepEqual(result, { childId: 'child' })
    assert.deepEqual(attempts[0], [...CAPTAIN_TOOL_NAMES, 'subagent', 'send_message'])
    assert.deepEqual(attempts[1], [...CAPTAIN_TOOL_NAMES])
  })

  await t.test('a first attempt that already works is not retried', async () => {
    let calls = 0
    await startMemberWithLenientFilter(async () => { calls += 1; return 'ok' }, [...CAPTAIN_TOOL_NAMES])
    assert.equal(calls, 1)
  })

  await t.test('an unrelated start failure still surfaces', async () => {
    await assert.rejects(
      startMemberWithLenientFilter(async () => { throw new Error('provider "spawn" is not registered') }, [...CAPTAIN_TOOL_NAMES]),
      /is not registered/,
    )
  })

  await t.test('a non-error rejection does not loop forever', async () => {
    await assert.rejects(startMemberWithLenientFilter(async () => { throw 'opaque failure' }, [...CAPTAIN_TOOL_NAMES]))
  })
})

test('a member capability restriction drops names the composition does not register', async t => {
  const stub = registered => {
    const applied = []
    return {
      applied,
      tools: {
        restrict(filter) {
          const unknown = filter.deny.filter(name => !registered.includes(name))
          if (unknown.length > 0) throw hostRejection(unknown)
          applied.push([...filter.deny])
          return () => {}
        },
      },
    }
  }

  await t.test('the remaining names are applied', () => {
    const host = stub([...CAPTAIN_TOOL_NAMES])
    restrictMemberTools(host, [...CAPTAIN_TOOL_NAMES, 'subagent', 'send_message'])
    assert.deepEqual(host.applied.at(-1), [...CAPTAIN_TOOL_NAMES])
  })

  await t.test('an unrelated restriction failure still surfaces', () => {
    const failing = { tools: { restrict() { throw new Error('tools.restrict() requires a scoped context') } } }
    assert.throws(() => restrictMemberTools(failing, [...CAPTAIN_TOOL_NAMES]), /requires a scoped context/)
  })

  await t.test('a non-error rejection does not loop forever', () => {
    const failing = { tools: { restrict() { throw 'opaque failure' } } }
    assert.throws(() => restrictMemberTools(failing, [...CAPTAIN_TOOL_NAMES]))
  })
})
