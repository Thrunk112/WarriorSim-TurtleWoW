'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const tests = [];

function test(name, callback) {
    tests.push({name, callback});
}

function loadSimulation() {
    const context = vm.createContext({
        console,
        getGlobalsDelta: () => ({}),
        setTimeout,
        clearTimeout,
        Worker: class {},
    });

    for (const relativePath of ['js/classes/simulation.js', 'js/classes/player.js']) {
        const filename = path.join(ROOT, relativePath);
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename});
    }

    vm.runInContext(`
        this.__testExports = {
            Player,
            SimulationWorkerParallel,
            generateSimulationSeed:
                typeof generateSimulationSeed === 'function' ? generateSimulationSeed : undefined,
            simulationIterationSeed:
                typeof simulationIterationSeed === 'function' ? simulationIterationSeed : undefined,
            setSimulationSeed:
                typeof setSimulationSeed === 'function' ? setSimulationSeed : undefined,
            simulationRandom:
                typeof simulationRandom === 'function' ? simulationRandom : undefined,
        };
    `, context);

    return context.__testExports;
}

function makeResetPlayer(Player, overrides = {}) {
    const player = Object.create(Player.prototype);
    Object.assign(player, {
        reactionmin: 100,
        reactionmax: 200,
        stats: {haste: 1},
        mh: {timer: 999},
        oh: null,
        spells: {},
        auras: {},
        trinketproc1: null,
        trinketproc2: null,
        initStances() {},
        update() {},
    }, overrides);
    return player;
}

function makeReport({maxdps = 0, endtime = 0, totalusedrage} = {}) {
    const report = {
        iterations: 1,
        totaldmg: 100,
        totalduration: 10,
        mindps: 10,
        maxdps,
        sumdps: 10,
        sumdps2: 100,
        starttime: 1,
        endtime,
    };
    if (totalusedrage !== undefined) {
        report.player = {
            auras: {},
            spells: {
                execute: {totaldmg: 50, totalusedrage, data: [1, 0, 0, 0, 0]},
            },
            mh: {totaldmg: 50, totalprocdmg: 0, data: [1, 0, 0, 0, 0]},
            oh: null,
        };
    }
    return report;
}

function mergeReports(SimulationWorkerParallel, first, second) {
    let result;
    const parallel = Object.create(SimulationWorkerParallel.prototype);
    parallel.states = [
        {status: 1, data: first},
        {status: 1, data: second},
    ];
    parallel.callback_finished = value => { result = value; };
    parallel.callback_update = () => {};
    parallel.update();
    return result;
}

test('reset clears a free Shield Slam proc between fights', () => {
    const {Player} = loadSimulation();
    const player = makeResetPlayer(Player, {freeshieldslam: true});

    player.reset(0);

    assert.equal(player.freeshieldslam, false);
});

test('reset clears mutable spell state between fights', () => {
    const {Player} = loadSimulation();
    const spell = {
        timer: 5000,
        stacks: 3,
        maxdelay: 999,
        unqueuetimer: 999,
        usedrage: 47,
        backupheroic: {maxdelay: 999, unqueuetimer: 999},
    };
    const player = makeResetPlayer(Player, {spells: {execute: spell}});

    player.reset(0);

    assert.equal(spell.timer, 0);
    assert.equal(spell.stacks, 0);
    assert.equal(spell.maxdelay, player.reactionmin);
    assert.equal(spell.usedrage, 0);
    assert.ok(spell.unqueuetimer >= 300 + player.reactionmin);
    assert.ok(spell.unqueuetimer <= 300 + player.reactionmax);
    assert.equal(spell.backupheroic.maxdelay, player.reactionmin);
    assert.ok(spell.backupheroic.unqueuetimer >= 300 + player.reactionmin);
    assert.ok(spell.backupheroic.unqueuetimer <= 300 + player.reactionmax);
});

test('reset clears mutable aura state between fights', () => {
    const {Player} = loadSimulation();
    const aura = {
        timer: 5000,
        firstuse: false,
        stacks: 3,
        starttimer: 450,
        maxdelay: 999,
        mintime: 700,
        ticksleft: 4,
        saveddmg: 120,
        nexttick: 1000,
        cooldowntimer: 6000,
        tfbstep: 3000,
    };
    const player = makeResetPlayer(Player, {auras: {testaura: aura}});

    player.reset(0);

    assert.deepEqual({
        timer: aura.timer,
        firstuse: aura.firstuse,
        stacks: aura.stacks,
        starttimer: aura.starttimer,
        maxdelay: aura.maxdelay,
        mintime: aura.mintime,
        ticksleft: aura.ticksleft,
        saveddmg: aura.saveddmg,
        nexttick: aura.nexttick,
        cooldowntimer: aura.cooldowntimer,
        tfbstep: aura.tfbstep,
    }, {
        timer: 0,
        firstuse: true,
        stacks: 0,
        starttimer: 0,
        maxdelay: player.reactionmin,
        mintime: 0,
        ticksleft: 0,
        saveddmg: 0,
        nexttick: 0,
        cooldowntimer: 0,
        tfbstep: -6000,
    });
});

test('reset schedules the initial off-hand swing using refreshed haste', () => {
    const {Player} = loadSimulation();
    const player = makeResetPlayer(Player, {
        oh: {speed: 2, timer: 999},
        update() { this.stats.haste = 2; },
    });

    player.reset(0);

    assert.equal(player.oh.timer, 500);
});

test('parallel reports retain the highest DPS result', () => {
    const {SimulationWorkerParallel} = loadSimulation();
    const result = mergeReports(
        SimulationWorkerParallel,
        makeReport({maxdps: 125}),
        makeReport({maxdps: 275}),
    );

    assert.equal(result.maxdps, 275);
});

test('parallel reports retain the latest worker completion time', () => {
    const {SimulationWorkerParallel} = loadSimulation();
    const result = mergeReports(
        SimulationWorkerParallel,
        makeReport({endtime: 100}),
        makeReport({endtime: 250}),
    );

    assert.equal(result.endtime, 250);
});

test('parallel reports add spell rage usage from every worker', () => {
    const {SimulationWorkerParallel} = loadSimulation();
    const result = mergeReports(
        SimulationWorkerParallel,
        makeReport({totalusedrage: 40}),
        makeReport({totalusedrage: 65}),
    );

    assert.equal(result.player.spells.execute.totalusedrage, 105);
});

test('parallel workers receive one seed and contiguous iteration offsets', () => {
    const {SimulationWorkerParallel} = loadSimulation();
    const starts = [];
    const parallel = Object.create(SimulationWorkerParallel.prototype);
    parallel.workers = [0, 1, 2].map(() => ({start: params => starts.push(params)}));

    parallel.start({
        sim: {iterations: 10, seed: 0x12345678, iterationOffset: 7},
        player: [null, null, null, {}],
        fullReport: false,
    });

    assert.deepEqual(starts.map(params => params.sim.iterations), [3, 4, 3]);
    assert.deepEqual(starts.map(params => params.sim.iterationOffset), [7, 10, 14]);
    assert.deepEqual(starts.map(params => params.sim.seed), [0x12345678, 0x12345678, 0x12345678]);
});

test('each global iteration has a deterministic random stream', () => {
    const {
        simulationIterationSeed,
        setSimulationSeed,
        simulationRandom,
    } = loadSimulation();
    assert.equal(typeof simulationIterationSeed, 'function');
    assert.equal(typeof setSimulationSeed, 'function');
    assert.equal(typeof simulationRandom, 'function');

    const baseSeed = 0x12345678;
    const sample = iteration => {
        setSimulationSeed(simulationIterationSeed(baseSeed, iteration));
        return [simulationRandom(), simulationRandom(), simulationRandom()];
    };
    const uninterrupted = [0, 1, 2, 3, 4, 5].map(sample);
    const partitioned = [
        ...[0, 1].map(sample),
        ...[2, 3, 4].map(sample),
        ...[5].map(sample),
    ];

    assert.deepEqual(partitioned, uninterrupted);
    assert.notDeepEqual(uninterrupted[0], uninterrupted[1]);
});

test('glancing damage uses the deterministic simulation stream', () => {
    const {Player, setSimulationSeed, simulationRandom} = loadSimulation();
    assert.equal(typeof setSimulationSeed, 'function');
    assert.equal(typeof simulationRandom, 'function');

    const seed = 0x89ABCDEF;
    setSimulationSeed(seed);
    const roll = simulationRandom();
    setSimulationSeed(seed);

    const player = Object.create(Player.prototype);
    player.mode = 'turtle';
    player.target = {defense: 315};
    player.stats = {skill_3: 300};
    const low = 0.555;
    const high = 0.745;

    assert.equal(player.getGlanceReduction({type: 3}), roll * (high - low) + low);
});

let failures = 0;
for (const {name, callback} of tests) {
    try {
        callback();
        console.log(`PASS ${name}`);
    } catch (error) {
        ++failures;
        console.error(`FAIL ${name}`);
        console.error(error.stack || error);
    }
}
if (failures) {
    console.error(`${failures} of ${tests.length} tests failed`);
    process.exitCode = 1;
} else {
    console.log(`${tests.length} tests passed`);
}
