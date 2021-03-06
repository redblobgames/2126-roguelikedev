/*
 * From https://www.redblobgames.com/x/2126-roguelike-dev/
 * Copyright 2021 Red Blob Games <redblobgames@gmail.com>
 * License: Apache-2.0 <http://www.apache.org/licenses/LICENSE-2.0.html>
 */

import { NUM_LAYERS, entities } from "./entity";
import { WIDTH, HEIGHT, Edge, edgeJoins, gameMap } from "./map";
import { xpForLevel, playerMoveBy, playerPickupItem, useItem, dropItem, playerGoDownStairs } from "./simulation";

const VIEWWIDTH = 17, VIEWHEIGHT = 17;
let DEBUG_ALL_VISIBLE = false;


const display = {
    el: document.querySelector("#game") as SVGSVGElement,
    eventToPosition(event: MouseEvent) {         // Compatibility with ROT.js
        let point = this.el.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        let coords = point.matrixTransform(this.el.querySelector(".view").getScreenCTM().inverse());
        let x = Math.floor(coords.x), y = Math.floor(coords.y);
        if (0 <= x && x < WIDTH && 0 <= y && y < HEIGHT) { return [x, y]; }
        else { return [-1, -1]; }
    },
};


/** console messages */
const MAX_MESSAGE_LINES = 100;
let messages = []; // [text, className]
function drawMessages() {
    let messageBox = document.querySelector("#messages");
    // If there are more messages than there are <div>s, add some
    while (messageBox.children.length < messages.length) {
        messageBox.appendChild(document.createElement('div'));
    }
    // Remove any extra <div>s
    while (messages.length < messageBox.children.length) {
        messageBox.removeChild(messageBox.lastChild);
    }
    // Update the <div>s to have the right message text and color
    for (let line = 0; line < messages.length; line++) {
        let div = messageBox.children[line];
        div.textContent = messages[line][0];
        div.setAttribute('class', messages[line][1]);
    }
    // Scroll to the bottom
    messageBox.scrollTop = messageBox.scrollHeight;
}

export function print(message: string, className: string) {
    messages.push([message, className]);
    messages.splice(0, messages.length - MAX_MESSAGE_LINES);
    drawMessages();
}




let previouslyDrawnSprites = Array.from({length: NUM_LAYERS}, () => new Map<number, SVGElement>());

export function draw() {
    const player = entities.player;
    gameMap.setExplored(player.location);
    
    document.querySelector<HTMLElement>("#health-bar").style.width = `${Math.ceil(100*player.hp/player.effective_max_hp)}%`;
    document.querySelector<HTMLElement>("#health-text").textContent = ` HP: ${player.hp} / ${player.effective_max_hp}`;

    const debugScale = DEBUG_ALL_VISIBLE ? 1.5 : 1;
    const viewWidth = VIEWWIDTH * debugScale;
    const viewHeight = VIEWHEIGHT * debugScale;
    
    // Draw the map
    let svgTileHtml = ``;
    let svgWallHtml = ``;
    function explored(x: number, y: number) { return gameMap.isExplored({x, y}) || DEBUG_ALL_VISIBLE; }
    function drawEdge(edge: Edge) {
        let edgeData = gameMap.edges.get(edge);
        if (!edgeData) { return; } // nothing here

        let [tile1, tile2] = edgeJoins(edge);
        let isExplored = explored(tile1.x, tile1.y) || explored(tile2.x, tile2.y);
        if (!isExplored) { return; } // can't be seen
        
        let isVisible = gameMap.isVisible(player.location, tile1) || gameMap.isVisible(player.location, tile2);
        let [dx, dy] = edge.s === 'W'? [0, 1] : [1, 0];
        let fg = isVisible? "hsl(50, 15%, 65%)" : "hsl(250, 15%, 50%)";
        let fgBright = isVisible? "hsl(50, 15%, 85%)" : "hsl(250, 15%, 65%)";

        switch (edgeData) {
            case 'wall': svgWallHtml += `<path d="M ${edge.x},${edge.y} l ${dx},${dy}" 
                                               fill="none" stroke="${fg}" stroke-width="0.1" stroke-linecap="round"/>`; break;
            case 'closed-door': svgWallHtml += `<path d="M ${edge.x+dx*0.2},${edge.y+dy*0.2} l ${dx*0.6},${dy*0.6}" 
                                                      fill="none" stroke="${fgBright}" stroke-width="0.3" stroke-linecap="butt"/>`; break;
            case 'open-door': svgWallHtml += `<path d="M ${edge.x+dx*0.1-dy*0.1},${edge.y+dy*0.1+dx*0.1} l ${dy*0.2},${-dx*0.2} 
                                                       M ${edge.x+dx*0.9-dy*0.1},${edge.y+dy*0.9+dx*0.1} l ${dy*0.2},${-dx*0.2}" 
                                                    fill="none" stroke="${fgBright}" stroke-width="0.15" stroke-linecap="butt"/>`; break;
        }
    }
    
    for (let y = Math.floor(player.location.y - viewHeight/2);
         y <= Math.ceil(player.location.y + viewHeight/2); y++) {
        for (let x = Math.floor(player.location.x - viewWidth/2);
             x <= Math.ceil(player.location.x + viewWidth/2); x++) {
            let lit = gameMap.isVisible(player.location, {x, y});
            if (lit || explored(x, y)) {
                let bg = lit ? "hsl(50, 5%, 35%)" : "hsl(250, 10%, 25%)";
                svgTileHtml += `<rect x="${x}" y="${y}" width="1" height="1" fill="${bg}" stroke="${bg}" stroke-width="0.05"/>`;
            }
            drawEdge({x, y, s: 'W'});
            drawEdge({x, y, s: 'N'});
        }
    }
    display.el.querySelector<HTMLElement>(".view").style.transform =
        `translate(50px, 50px) 
         scale(${100/viewWidth}, ${100/viewHeight})
         translate(-0.5px, -0.5px)
         translate(${-player.location.x}px, ${-player.location.y}px)`;
    display.el.querySelector(".map").innerHTML = svgTileHtml + svgWallHtml;

    // Draw the entities on top of the map. This is a little tricky in
    // SVG because there are two conflicting goals:
    //    1. I want to use CSS transition, so I need to reuse the DOM nodes.
    //    2. SVG draws in DOM order, so I need the DOM to be in my order.
    // But the various ways to reorder DOM nodes lose the CSS transitions!
    // So my solution is to not have a total order, but only have layers,
    // and then have CSS transitions only work within a layer.
    let spritesToDraw = Array.from({length: NUM_LAYERS}, () => new Map<number, SVGElement>());
    let entitiesArray = Array.from(entities.onMap());
    for (let entity of entitiesArray) {
        let explored = gameMap.isExplored(entity.location) || DEBUG_ALL_VISIBLE;
        if (gameMap.isVisible(player.location, entity.location) || (explored && entity.visible_in_shadow)) {
            let layer = entity.render_layer;
            let [sprite, fg] = entity.visuals;
            // Draw it twice, once to make a wide outline to partially
            // obscure anything else on the same tile
            let node = previouslyDrawnSprites[layer].get(entity.id);
            if (!node) { node = document.createElementNS("http://www.w3.org/2000/svg", 'g'); }
            node.setAttribute('class', "entity");
            node.innerHTML = `
                <use class="entity-bg" width="1" height="1" href="#${sprite}"/>
                <use class="entity-fg" width="1" height="1" href="#${sprite}" fill="${fg}"/>
            `;
            node.style.transform = `translate(${entity.location.x}px,${entity.location.y}px) translate(0.5px,0.5px) scale(0.9) translate(-0.5px,-0.5px)`;
            spritesToDraw[layer].set(entity.id, node);
        }
    }
    for (let layer = 0; layer < NUM_LAYERS; layer++) {
        let g = display.el.querySelector(`.entities-${layer}`);
        for (let [id, node] of spritesToDraw[layer].entries()) {
            if (!previouslyDrawnSprites[layer].has(id)) {
                g.appendChild(node);
            }
        }
        for (let [id, node] of previouslyDrawnSprites[layer].entries()) {
            if (!spritesToDraw[layer].has(id)) {
                g.removeChild(node);
            }
        }
        previouslyDrawnSprites[layer] = spritesToDraw[layer];
    }
    
    drawInventory();
    updateInstructions();
}

function drawInventory() {
    const fontSize = 4.5, spacing = 4, overlaySpacing = 1, verticalSpacing = 6;
    const area = display.el.querySelector(`.inventory`);
    let buttonsHtml = ``;
    let carriedByPlayer = Array.from(entities.player.inventory.keys()).map(id => entities.get(id));
    for (let slot = 1; slot <= 9; slot++) {
        buttonsHtml += `<g transform="translate(0, ${slot*verticalSpacing})">`;
        buttonsHtml += `<text>${slot}</text>`;
        let entitiesOfType = carriedByPlayer.filter(entity => entity.inventory_slot === slot);
        for (let i = 0; i < entitiesOfType.length; i++) {
            let entity = entitiesOfType[i];
            let [sprite, fg] = entity.visuals;
            buttonsHtml += `<g class="entity" transform="translate(${spacing + overlaySpacing * i}, ${-fontSize})">
                              <use class="entity-bg" width="${fontSize}" height="${fontSize}" href="#${sprite}"/>
                              <use class="entity-fg" width="${fontSize}" height="${fontSize}" href="#${sprite}" fill="${fg}"/>
                           </g>`;
            if (i === 0) buttonsHtml += `<text x="${spacing*3}">${entity.name}</text>`;
        }
        buttonsHtml += `</g>`;
    }
    area.innerHTML = `<rect width="100" height="100" fill="gray" />
      <g font-size="${fontSize}" font-family="sans-serif">
        ${buttonsHtml}
      </g>`;
}

function updateInstructions() {
    const instructions = document.getElementById('game-instructions');
    const player = entities.player;
    let standingOn = entities.allAt(player.location.x, player.location.y);
    
    let html = ``;
    if (currentKeyHandler() === handlePlayerKeys) {
        html = `Arrows move`;
        let onItem = standingOn.filter(e => e.item).length > 0;
        let onStairs = standingOn.filter(e => e.stairs).length > 0;
        if (onItem) html += `, <kbd>G</kbd>et item`;
        if (onStairs) html += `, <kbd>&gt;</kbd> stairs`;
    }
    instructions.innerHTML = html;
}


/** overlay messages - hide if text is empty, optionally clear automatically */
const [setOverlayMessage, _setTemporaryOverlayMessage] = (() => {
    let area = document.querySelector("#message-overlay");
    let timeout = 0;
    function set(text: string) {
        clearTimeout(timeout);
        area.textContent = text;
        area.classList.toggle('visible', !!text);
    }
    return [
        set,
        function(text: string) {
            set(text);
            timeout = setTimeout(() => { area.classList.remove('visible'); }, 1000);
        }
    ];
})();



//////////////////////////////////////////////////////////////////////
// ui
type Action = any[];

function createTargetingOverlay() {
    const overlay = document.querySelector(`#targeting`);
    let visible = false;
    let callback = (_x: number, _y: number): void => { throw `set callback`; };

    function onClick(event: MouseEvent) {
        let [x, y] = display.eventToPosition(event);
        callback(x, y);
        // Ugh, the overlay is nice for capturing mouse events but
        // when you click, the game loses focus. Workaround:
        display.el.focus();
    }
    function onMouseMove(event: MouseEvent) {
        let [_x, _y] = display.eventToPosition(event);
        // TODO: feedback
    }

    overlay.addEventListener('click', onClick);
    overlay.addEventListener('mousemove', onMouseMove);

    return {
        get visible() { return visible; },
        open(instructions: string, callback_: (x: number, y: number) => void) {
            visible = true;
            callback = callback_;
            overlay.classList.add('visible');
            overlay.innerHTML = `<div>${instructions}</div>`;
        },
        close() {
            visible = false;
            overlay.classList.remove('visible');
        },
    };
}

function createCharacterOverlay() {
    const overlay = document.querySelector(`#overlay-character`);
    let visible = false;

    return {
        get visible() { return visible; },
        open() {
            const player = entities.player;
            const experienceToLevel = xpForLevel(player.level) - player.xp;
            const equipmentHTML = player.equipment
                .filter((id: number|null) => id !== null)
                .map((id: number) => entities.get(id).type)
                .join(" and ");
            overlay.innerHTML = `<div>Character information</div>
             <ul>
               <li>Level: ${player.level}</li>
               <li>Experience: ${player.xp}</li>
               <li>Experience to Level: ${experienceToLevel}</li>
               <li>Maximum HP: ${player.base_max_hp} + ${player.increased_max_hp}</li>
               <li>Attack: ${player.base_power} + ${player.increased_power}</li>
               <li>Defense: ${player.base_defense} + ${player.increased_defense}</li>
             </ul>
             <p>Equipped: ${equipmentHTML}</p>
             <div><kbd>ESC</kbd> to exit</div>`;
            
            visible = true;
            overlay.classList.add('visible');
        },
        close() {
            visible = false;
            overlay.classList.remove('visible');
        },
    };
}

function createUpgradeOverlay() {
    const overlay = document.querySelector(`#upgrade`);
    let visible = false;

    return {
        get visible() { return visible; },
        open() {
            const player = entities.player;
            visible = true;
            overlay.innerHTML = `<div>Level up! Choose a stat to raise:</div>
             <ul>
               <li><kbd>A</kbd> Constitution (+20 HP, from ${player.base_max_hp})</li>
               <li><kbd>B</kbd> Strength (+1 attack, from ${player.base_power})</li>
               <li><kbd>C</kbd> Agility (+1 defense, from ${player.base_defense})</li>
             </ul>`;
            overlay.classList.add('visible');
        },
        close() {
            visible = false;
            overlay.classList.remove('visible');
        },
    };
}

function handlePlayerDeadKeys(key: string): Action {
    const actions = {
        o:  ['toggle-debug'],
        c:  ['character-open'],
    };
    return actions[key];
}

function handlePlayerKeys(key: string): Action {
    const actions = {
        ArrowRight:  ['move', +1, 0],
        ArrowLeft:   ['move', -1, 0],
        ArrowDown:   ['move', 0, +1],
        ArrowUp:     ['move', 0, -1],
        l:           ['move', +1, 0],
        h:           ['move', -1, 0],
        j:           ['move', 0, +1],
        k:           ['move', 0, -1],
        z:           ['move', 0, 0],
        g:           ['pickup'],
        '>':         ['stairs-down'],
        '1':         ['use', 1],
        '2':         ['use', 2],
        '3':         ['use', 3],
        '4':         ['use', 4],
        '5':         ['use', 5],
        '6':         ['use', 6],
        '7':         ['use', 7],
        '8':         ['use', 8],
        '9':         ['use', 9],
    };
    let action = actions[key];
    return action || handlePlayerDeadKeys(key);
}

function handleUpgradeKeys(key: string): Action {
    const actions = {
        a:  ['upgrade', 'hp'],
        b:  ['upgrade', 'str'],
        c:  ['upgrade', 'def'],
    };
    return actions[key];
}

function handleCharacterKeys(key: string): Action {
    return (key === 'Escape' || key == 'c') && ['character-close'];
}
    
function handleTargetingKeys(key: string): Action {
    return key === 'Escape' && ['targeting-cancel'];
}

function runAction(action: Action) {
    const player = entities.player;
    switch (action[0]) {
        case 'move': {
            let [_, dx, dy] = action;
            playerMoveBy(dx, dy);
            break;
        }

        case 'pickup':               { playerPickupItem();           break; }
        case 'stairs-down':          { playerGoDownStairs();         break; }
        case 'character-open':       { characterOverlay.open();      break; }
        case 'character-close':      { characterOverlay.close();     break; }
        case 'targeting-cancel':     { targetingOverlay.close();     break; }

        case 'use': {
            let [_, inventory_slot] = action;
            let candidates = (Array.from(player.inventory.keys()) as number[])
                                 .map(id => entities.get(id))
                                 .filter(entity => entity.inventory_slot === inventory_slot);
            if (candidates.length > 0) {
                useItem(player, candidates[0]);
            }
            break;
        }
        case 'upgrade': {
            let [_, stat] = action;
            switch (stat) {
                case 'hp':
                    player.base_max_hp += 20;
                    player.hp += 20;
                    break;
                case 'str':
                    player.base_power += 1;
                    break;
                case 'def':
                    player.base_defense += 1;
                    break;
                default:
                    throw `invalid upgrade ${stat}`;
            }
            upgradeOverlay.close();
            break;
        }
        case 'toggle-debug': {
            DEBUG_ALL_VISIBLE = !DEBUG_ALL_VISIBLE;
            break;
        }
        default:
            throw `unhandled action ${action}`;
    }
    draw();
}

function currentKeyHandler() {
    return targetingOverlay.visible? handleTargetingKeys
         : upgradeOverlay.visible? handleUpgradeKeys
         : characterOverlay.visible? handleCharacterKeys
         : entities.player.dead? handlePlayerDeadKeys
         : handlePlayerKeys;
}

function handleKeyDown(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let action = currentKeyHandler()(event.key);
    if (action) {
        event.preventDefault();
        runAction(action);
    }
}

function handleMousemove(event: MouseEvent) {
    let [x, y] = display.eventToPosition(event); // returns -1, -1 for out of bounds
    let entitiesAtMouse = gameMap.isVisible(entities.player.location, {x, y}) ? entities.allAt(x, y) : [];
    let text = entitiesAtMouse.map(e => e.name).join("\n");
    setOverlayMessage(text);
}

function handleMouseout(_event: MouseEvent) {
    setOverlayMessage("");
}

function setupInputHandlers() {
    const canvas = display.el;
    const instructions = document.getElementById('focus-instructions');
    canvas.setAttribute('tabindex', "1");
    canvas.addEventListener('keydown', handleKeyDown);
    canvas.addEventListener('mousemove', handleMousemove);
    canvas.addEventListener('mouseout', handleMouseout);
    canvas.addEventListener('blur', () => { instructions.classList.add('visible'); });
    canvas.addEventListener('focus', () => { instructions.classList.remove('visible'); });
    canvas.focus();
}

export const targetingOverlay = createTargetingOverlay();
export const upgradeOverlay = createUpgradeOverlay();
export const characterOverlay = createCharacterOverlay();
setupInputHandlers();
draw();
