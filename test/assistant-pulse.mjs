// The broker's scheduler pulse to the daily assistant: it says whether the extension is
// connected, pulses on while it is away, and reports a closed connection even when a
// newer one is already open or a pulse is in flight. Pure unit, no ports.
import assert from 'node:assert/strict';
import { AssistantPulse } from '../dist/assistant-pulse.mjs';
import { watchdog } from './watchdog.mjs';

const stopWatchdog = watchdog();
const sent = [];
let connected = true, hold;
const pulse = new AssistantPulse(async browserConnected => { sent.push(browserConnected); if (hold) await hold; }, () => connected);

// Every pulse reads the bridge when it is sent, connected or not.
await pulse.pulse();
connected = false; await pulse.pulse();
assert.deepEqual(sent, [true, false], 'the timer pulse goes on while the extension is away');

// A closed connection is reported as lost even when the new connection already counts as open.
connected = true; sent.length = 0;
await pulse.pulse(true);
assert.deepEqual(sent, [false], 'a superseded connection is still a lost one');
await pulse.pulse();
assert.deepEqual(sent, [false, true]);

// A timer pulse during one in flight is dropped; a lost connection during one in flight follows it, saying lost.
sent.length = 0;
let release; hold = new Promise(resolve => { release = resolve; });
const first = pulse.pulse();
await pulse.pulse();
await pulse.pulse(true);
await pulse.pulse(true);
assert.deepEqual(sent, [true], 'one pulse at a time');
hold = undefined; release(); await first;
assert.deepEqual(sent, [true, false], 'the loss that happened while the connected pulse was in flight follows it, once');

// A pulse that fails never stops the next one, nor a loss asked for while it was in flight.
const attempts = [];
let failingHold;
const failing = new AssistantPulse(async browserConnected => { attempts.push(browserConnected); if (failingHold) await failingHold; throw new Error('module unavailable'); }, () => true);
await failing.pulse(); await failing.pulse(true);
assert.deepEqual(attempts, [true, false], 'both pulses are sent, the second after the first failed');
attempts.length = 0;
let releaseFailing; failingHold = new Promise(resolve => { releaseFailing = resolve; });
const failingFirst = failing.pulse();
await failing.pulse(true);
failingHold = undefined; releaseFailing(); await failingFirst;
assert.deepEqual(attempts, [true, false], 'the loss asked for during a failing pulse follows it');
stopWatchdog();
console.log('Assistant pulse: pulses with and without the extension, a closed connection reported even after a reconnect, one pulse at a time with a loss never dropped, and failures that never stop the pulse passed');
