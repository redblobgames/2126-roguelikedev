/*
 * From https://www.redblobgames.com/x/2126-roguelike-dev/
 * Copyright 2021 Red Blob Games <redblobgames@gmail.com>
 * License: Apache-2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

import { RNG } from "./third-party/rotjs_lib/";
import { Point, entities } from "./entity";
import { randint, evaluateStepFunction } from "./util";

export const WIDTH = 40;
export const HEIGHT = 30;
export const NUM_ROOMS = 100;

type Side = 'W' | 'N';
type Edge = {x: number; y: number; s: Side};

type TileData = {
    roomId: RoomId;
    // maybe floor type, passability, water, etc
};

type TileMap<T> = {
    _values: any;
    keys(): {x: number, y: number}[];
    has(x: number, y: number): boolean;
    get(x: number, y: number): T;
    set(x: number, y: number, value: T): void;
};

type WallSet = {
    has(x: number, y: number, s: Side): boolean;
    add(x: number, y: number, s: Side): void;
    delete(x: number, y: number, s: Side): void;
};

type RoomId = number;
type DoorId = Edge;

type Room = {
    type: 'regular';
    center: Point;
    tiles: Point[];
    adjacent: {roomId: RoomId, doorId: DoorId}[];
    explored: boolean;
};

type GameMap = {
    dungeonLevel: number;
    tiles: TileMap<TileData>;
    walls: WallSet;
    rooms: Map<RoomId, Room>;
    doors: Map<String, {tile1: Point, tile2: Point, open: boolean}>;
    setExplored(at: Point): void;
    isExplored(at: Point): boolean;
    isVisible(from: Point, to: Point): boolean;
};

function tileToKey(p: Point): string { return `${p.x},${p.y}`; }
function edgeToKey(e: Edge): string { return `${e.x},${e.y},${e.s}`; }

function createTileMap<T>(): TileMap<T> {
    function key(x: number, y: number) { return tileToKey({x, y}); }
    return {
        _values: {}, // use object instead of Map so it can be saved to json
        keys() {
            return Object.keys(this._values).map(key => {
                let [x, y] = key.split(',');
                return {x: parseFloat(x), y: parseFloat(y)};
            });
        },
        has(x: number, y: number): boolean  { return this._values[key(x, y)] !== undefined; },
        get(x: number, y: number): T        { return this._values[key(x, y)]; },
        set(x: number, y: number, value: T) { this._values[key(x, y)] = value; },
    };
}

function createWallSet() {
    function key(x: number, y: number, s: Side) { return edgeToKey({x, y, s}); }
    return {
        _values: {},
        has(x: number, y: number, s: Side): boolean { return this._values[key(x, y, s)] !== undefined; },
        add(x: number, y: number, s: Side)          { this._values[key(x, y, s)] = true; },
        delete(x: number, y: number, s: Side)       { delete this._values[key(x, y, s)]; },
    };
}

function edgesAroundTile(p: Point): Edge[] {
    let {x, y} = p;
    return [
        {x, y, s: 'N'},
        {x, y, s: 'W'},
        {x, y: y+1, s: 'N'},
        {x: x+1, y, s: 'W'},
    ];
}

export function edgeBetween(a: Point, b: Point): undefined | Edge {
    if (a.x === b.x && a.y === b.y-1) { return {x: b.x, y: b.y, s: 'N'}; }
    if (a.x === b.x && a.y === b.y+1) { return {x: a.x, y: a.y, s: 'N'}; }
    if (a.x === b.x-1 && a.y === b.y) { return {x: b.x, y: b.y, s: 'W'}; }
    if (a.x === b.x+1 && a.y === b.y) { return {x: a.x, y: a.y, s: 'W'}; }
    return undefined;
}

function populateRoom(room: Room, dungeonLevel: number) {
    let maxMonstersPerRoom = evaluateStepFunction([[1, 2], [4, 3], [6, 5]], dungeonLevel),
        maxItemsPerRoom = evaluateStepFunction([[1, 1], [4, 2]], dungeonLevel);

    const ai = {behavior: 'move_to_player'};
    const monsterChances = {
        orc: 80,
        troll: evaluateStepFunction([[3, 15], [5, 30], [7, 60]], dungeonLevel),
    };
    const monsterProps = {
        orc:   {base_max_hp: 20, base_defense: 0, base_power: 4, ai},
        troll: {base_max_hp: 30, base_defense: 2, base_power: 8, ai},
    };
    
    const numMonsters = randint(0, maxMonstersPerRoom);
    for (let i = 0; i < numMonsters; i++) {
        let {x, y} = RNG.getItem(room.tiles);
        if (!entities.blockingEntityAt(x, y)) {
            let type = RNG.getWeightedValue(monsterChances);
            entities.create(type, {x, y}, monsterProps[type]);
        }
    }

    const itemChances = {
        'healing potion': 70,
        'lightning scroll': evaluateStepFunction([[4, 25]], dungeonLevel),
        'fireball scroll': evaluateStepFunction([[6, 25]], dungeonLevel),
        'confusion scroll': evaluateStepFunction([[2, 10]], dungeonLevel),
        sword: evaluateStepFunction([[4, 5]], dungeonLevel),
        shield: evaluateStepFunction([[8, 15]], dungeonLevel),
    };
    const numItems = randint(0, maxItemsPerRoom);
    for (let i = 0; i < numItems; i++) {
        let {x, y} = RNG.getItem(room.tiles);
        if (entities.allAt(x, y).length === 0) {
            entities.create(RNG.getWeightedValue(itemChances), {x, y});
        }
    }
}


function createGameMap(dungeonLevel: number): GameMap {
    let gameMap: GameMap = {
        dungeonLevel,
        tiles: createTileMap<TileData>(),
        walls: createWallSet(),
        rooms: new Map(),
        doors: new Map(),
        setExplored(at: Point) {
            let tileData = this.tiles.get(at.x, at.y);
            let room = this.rooms.get(tileData?.roomId);
            if (!room) throw "Invariant violated: setExplored on a non-room";
            room.explored = true;
        },
        isExplored(at: Point): boolean {
            let tileData = this.tiles.get(at.x, at.y);
            return this.rooms.get(tileData?.roomId)?.explored;
        },
        isVisible(from: Point, to: Point): boolean {
            let tile1 = this.tiles.get(from.x, from.y);
            let tile2 = this.tiles.get(to.x, to.y);
            if (!tile1) { throw "Invariant violated: isVisible should be called from inside a room"; }
            if (tile1.roomId === tile2?.roomId) {
                // You can see everything in the same room
                return true;
            }
            for (let {roomId, doorId} of this.rooms.get(tile1.roomId).adjacent) {
                // TODO: what about open doors vs closed doors?
                let door = this.doors.get(edgeToKey(doorId));
                if (roomId === tile2?.roomId &&
                    ((door.tile1.x === from.x && door.tile1.y === from.y)
                        || (door.tile2.x === from.x && door.tile2.y === from.y))) {
                    // You are standing next to a door, so you can see
                    // the room on the other side
                    return true;
                }
            }
            return false;
        },
    };

    const seeds = Array.from({length: NUM_ROOMS}, () => ({
        x: randint(0, WIDTH), y: randint(0, HEIGHT)
    }));
    const DIRS_8 = [[0, -1], [+1, 0], [0, +1], [-1, 0],
                    [-1, -1], [+1, -1], [+1, +1], [-1, +1]];
    gameMap.rooms = new Map(seeds.map((seed, index) => [index, {
        type: 'regular',
        center: seed,
        tiles: [],
        adjacent: [],
        explored: false,
    }]));

    for (let roomId = 0; roomId < NUM_ROOMS; roomId++) {
        let roomSize = randint(0, 100) < 10 ? {w: 10, h: 1}
            : randint(0, 100) < 10 ? {w: 1, h: 10}
            : roomId < NUM_ROOMS * 0.9 ? {w: randint(2, 8), h: randint(2, 8)}
            : {w: 15, h: 15};
        
        let left   = Math.max(0, seeds[roomId].x - (roomSize.w >> 1)),
            top    = Math.max(0, seeds[roomId].y - (roomSize.h >> 1)),
            right  = Math.min(WIDTH-1, left + roomSize.w - 1),
            bottom = Math.min(HEIGHT-1, top + roomSize.h - 1);

        let start = seeds[roomId];
        if (gameMap.tiles.has(start.x, start.y)) {
            // This room was placed inside an existing room, so skip it. It will be allocated 0 tiles.
            continue;
        }
        let queue = [start];
        let queueIndex = 0;
        gameMap.tiles.set(start.x, start.y, {roomId});
        while (queueIndex < queue.length) {
            let current = queue[queueIndex++];
            for (let neighbor of DIRS_8.map(([dx, dy]) => ({x: current.x + dx, y: current.y + dy}))) {
                if (neighbor.x < left || neighbor.x > right || neighbor.y < top || neighbor.y > bottom) {
                    continue; // out of bounds
                }
                if (!gameMap.tiles.has(neighbor.x, neighbor.y)) {
                    gameMap.tiles.set(neighbor.x, neighbor.y, {roomId});
                    queue.push(neighbor);
                }
            }
        }
        gameMap.rooms.get(roomId).tiles = queue;
    }

    gameMap.dungeonLevel = dungeonLevel;
    // Remove rooms that failed to allocate any tiles
    for (let [roomId, room] of gameMap.rooms.entries()) {
        if (room.tiles.length === 0) {
            gameMap.rooms.delete(roomId);
        }
    }

    // Add thin walls between rooms. One thin wall between each pair
    // of rooms will become a door.
    let doorCandidates = new Map<string, {tile1: Point, tile2: Point, edge: Edge}[]>();
    function addWallMaybe(x1: number, y1: number, x2: number, y2: number, edge: Edge) {
        let room1 = roomAt(x1, y1), room2 = roomAt(x2, y2);
        if (room1 !== room2) {
            gameMap.walls.add(edge.x, edge.y, edge.s);
            if (room1 !== null && room2 !== null) {
                // Wish we had something like python's setdefault
                let key = `${Math.min(room1, room2)},${Math.max(room1, room2)}`;
                let edges = doorCandidates.has(key) ? doorCandidates.get(key) : [];
                edges.push({tile1: {x: x1, y: y1}, tile2: {x: x2, y: y2}, edge});
                doorCandidates.set(key, edges);
            }
        }
    }
    function roomAt(x: number, y: number): RoomId | null { return gameMap.tiles.get(x, y)?.roomId ?? null; }
    for (let room of gameMap.rooms.values()) {
        for (let {x, y} of room.tiles) {
            addWallMaybe(x-1, y, x, y, {x, y, s: 'W'});
            addWallMaybe(x, y-1, x, y, {x, y, s: 'N'});
            addWallMaybe(x, y, x+1, y, {x: x+1, y, s: 'W'});
            addWallMaybe(x, y, x, y+1, {x, y: y+1, s: 'N'});
        }
    }

    // Now add doors by removing walls
    for (let doors of doorCandidates.values()) {
        let {tile1, tile2, edge} = RNG.getItem(doors);
        let roomId1 = roomAt(tile1.x, tile1.y), roomId2 = roomAt(tile2.x, tile2.y);
        if (roomId1 !== null && roomId2 !== null) {
            gameMap.walls.delete(edge.x, edge.y, edge.s);
            gameMap.doors.set(edgeToKey(edge), {tile1, tile2, open: false});
            gameMap.rooms.get(roomId1).adjacent.push({roomId: roomId2, doorId: edge});
            gameMap.rooms.get(roomId2).adjacent.push({roomId: roomId1, doorId: edge});
        }
    }

    // TODO: test if all or most the rooms are connected, start over if not? maybe need to find a large connected component and then throw away everything else
    
    // Put the player in the first room
    let nonEmptyRooms = Array.from(gameMap.rooms.values());
    let {x: playerX, y: playerY} = nonEmptyRooms[0].center;
    entities.moveEntityTo(entities.player, {x: playerX, y: playerY});

    // Put stairs in the last room
    let {x: stairX, y: stairY} = nonEmptyRooms[nonEmptyRooms.length-1].center;
    entities.create('stairs', {x: stairX, y: stairY});

    // Put monster and items in all the rooms
    for (let room of gameMap.rooms.values()) {
        populateRoom(room, dungeonLevel);
    }

    return gameMap;
}

export function goToNextLevel(): void {
    // NOTE: have to reuse the object because it's exported to other modules
    Object.assign(gameMap, createGameMap(gameMap.dungeonLevel + 1));
}

export const gameMap = {dungeonLevel: 0} as GameMap;
goToNextLevel();
