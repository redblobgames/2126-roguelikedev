/*
 * From https://www.redblobgames.com/x/2126-roguelike-dev/
 * Copyright 2021 Red Blob Games <redblobgames@gmail.com>
 * License: Apache-2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

import { RNG } from "./third-party/rotjs_lib/";
RNG.setSeed(127);

export function clamp(x: number, lo: number, hi: number): number {
    return x < lo ? lo : x > hi ? hi : x;
}

/** like python's randint */
export const randint = RNG.getUniformInt.bind(RNG);

/** euclidean distance */
export function distance(a: {x: number, y: number}, b: {x: number, y: number}): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/** step function: given a sorted table [[x, y], …] 
    and an input x1, return the y1 for the first x that is <x1 */
export function evaluateStepFunction(table: number[][], x: number) {
    let candidates = table.filter(xy => x >= xy[0]);
    return candidates.length > 0 ? candidates[candidates.length-1][1] : 0;
}
