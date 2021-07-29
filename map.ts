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

export type Side = 'W' | 'N';
export type Edge = {x: number; y: number; s: Side};

/** For convenience, a Map object that has a way to convert the key into a string */
class KeyMap<T, U> extends Map {
    toStr: (key: T) => string;
    constructor (toStr: (key: T) => string) {
        super();
        this.toStr = toStr;
    }
    get(key: T): U        { return super.get(this.toStr(key)); }
    has(key: T): boolean  { return super.has(this.toStr(key)); }
    set(key: T, value: U) { return super.set(this.toStr(key), value); }
    delete(key: T)        { return super.delete(this.toStr(key)); }
}

type TileData = {
    roomId: RoomId;
    // maybe floor type, passability, water, etc
};
type TileMap = KeyMap<Point, TileData>;

type EdgeData = 'wall' | 'closed-door' | 'open-door';
type EdgeMap = KeyMap<Edge, EdgeData>;

type RoomId = number;
type DoorId = Edge;

type Room = {
    type: 'regular';
    center: Point;
    tiles: Point[];
    adjacent: {roomId: RoomId, doorId: DoorId}[];
    explored: boolean;
};

class GameMap {
    dungeonLevel: number = 1;
    tiles: TileMap = new KeyMap(tileToKey);
    edges: EdgeMap = new KeyMap(edgeToKey);
    rooms: Map<RoomId, Room> = new Map();
    
    setExplored(at: Point): void {
        let tileData = this.tiles.get(at);
        let room = this.rooms.get(tileData?.roomId);
        if (!room) throw "Invariant violated: setExplored on a non-room";
        room.explored = true;
    }
    
    isExplored(at: Point): boolean {
        let tileData = this.tiles.get(at);
        return this.rooms.get(tileData?.roomId)?.explored;
    }
    
    isVisible(from: Point, to: Point): boolean {
        let tile1 = this.tiles.get(from);
        let tile2 = this.tiles.get(to);
        if (!tile1) { throw "Invariant violated: isVisible should be called from inside a room"; }
        if (tile1.roomId === tile2?.roomId) {
            // You can see everything in the same room
            return true;
        }
        for (let {edge, tile} of adjacentToTile(from)) {
            if (this.edges.get(edge) === 'open-door'
                && gameMap.tiles.get(tile)?.roomId === tile2?.roomId) {
                return true; // You can see into this room because there's an open door
            }
        }
        return false;
    }
};

function tileToKey(p: Point): string { return `${p.x},${p.y}`; }
function edgeToKey(e: Edge): string { return `${e.x},${e.y},${e.s}`; }

function adjacentToTile(p: Point): {edge: Edge, tile: Point}[] {
    let {x, y} = p;
    return [
        {edge: {x, y, s: 'N'}, tile: {x, y: y-1}},
        {edge: {x, y, s: 'W'}, tile: {x: x-1, y}},
        {edge: {x, y: y+1, s: 'N'}, tile: {x, y: y+1}},
        {edge: {x: x+1, y, s: 'W'}, tile: {x: x+1, y}},
    ];
}

export function edgeJoins(edge: Edge): [Point, Point] {
    let tile1 = {x: edge.x, y: edge.y};
    let tile2 = edge.s === 'W'? {x: edge.x-1, y: edge.y} : {x: edge.x, y: edge.y-1};
    return [tile1, tile2];
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
    let gameMap = new GameMap();

    const seeds = Array.from({length: NUM_ROOMS}, () => ({
        x: randint(0, WIDTH), y: randint(0, HEIGHT)
    }));
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
        
        let start = seeds[roomId];
        if (gameMap.tiles.has(start)) {
            // This room was placed inside an existing room, so skip it. It will be allocated 0 tiles.
            continue;
        }

        gameMap.tiles.set(start, {roomId});

        let assignedTiles = [start];
        function expand(x1: number, y1: number, x2: number, y2: number, {dx, dy}): void {
            for (let x = x1; x <= x2; x++) {
                for (let y = y1; y <= y2; y++) {
                    if (gameMap.tiles.get({x, y})?.roomId === roomId
                        && !gameMap.tiles.has({x: x + dx, y: y + dy})) {
                        gameMap.tiles.set({x: x + dx, y: y + dy}, {roomId});
                        assignedTiles.push({x: x + dx, y: y + dy});
                    }
                }
            }
        }

        let left   = start.x;
        let top    = start.y;
        let right  = start.x;
        let bottom = start.y;

        for (let distance = 1; distance <= Math.max(roomSize.w, roomSize.h)/2; distance++) {
            if (distance <= roomSize.w/2) {
                expand(left, top, left, bottom, {dx: -1, dy: 0}); left--;
                expand(right, top, right, bottom, {dx: +1, dy: 0}); right++;
            }
            if (distance <= roomSize.h/2) {
                expand(left, top, right, top, {dx: 0, dy: -1}); top--;
                expand(left, bottom, right, bottom, {dx: 0, dy: +1}); bottom++;
            }
        }
        
        gameMap.rooms.get(roomId).tiles = assignedTiles;
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
        let tile1 = {x: x1, y: y1};
        let tile2 = {x: x2, y: y2};
        let room1 = gameMap.tiles.get(tile1)?.roomId, room2 = gameMap.tiles.get(tile2)?.roomId;
        if (room1 !== room2) {
            gameMap.edges.set(edge, 'wall');
            if (room1 !== undefined && room2 !== undefined) {
                // Wish we had something like python's setdefault
                let key = `${Math.min(room1, room2)},${Math.max(room1, room2)}`;
                let edges = doorCandidates.has(key) ? doorCandidates.get(key) : [];
                edges.push({tile1, tile2, edge});
                doorCandidates.set(key, edges);
            }
        }
    }
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
        let roomId1 = gameMap.tiles.get(tile1)?.roomId, roomId2 = gameMap.tiles.get(tile2)?.roomId;
        if (roomId1 !== undefined && roomId2 !== undefined) {
            gameMap.edges.set(edge, 'closed-door');
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

export const gameMap = new GameMap();
goToNextLevel();
