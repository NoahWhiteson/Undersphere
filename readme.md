# Undersphere

Undersphere is a fast paced arena shooter where your world is a tiny, haunted planetoid. Gravity is your best friend and your worst enemy, always pulling you toward the core while you navigate a curved horizon where you can see your opponents running on the other side of the world.

## The World
The game takes place on a small graveyard planet covered in tall grass, scattered trees, and abandoned tents. Because the map is a sphere, there are no edges and no place to hide for long. If you run far enough in any direction, you will loop right back to where you started. This layout creates a constant state of tension because an enemy you just lost sight of might be flanking you from under your feet.

## Why Undersphere Feels So Good
We didn't just want a game that looked cool; we wanted one that felt heavy and responsive. We built a custom physics engine specifically for spherical gravity. Every jump, slide, and bullet trajectory accounts for the curvature of the planet. 

The movement is tuned to be fluid. You can sprint across the grass, crouch-slide into cover, or use the planet's curve to launch yourself into a jump that carries you over obstacles. When players are eliminated, they don't just disappear. We implemented procedural ragdolls that preserve the momentum of the final shot, sending bodies flying across the curved horizon in a satisfying display of physics.

## Core Features

### Fast Multiplayer
Matches are quick and synchronized through a high performance WebSocket backend. Everything from your teammate's aim to the muzzle flashes of their guns is synced in real time.

### Intelligent Bots
The planet is alive even when you are alone. Our AI bots use vision based hunting logic to track you down. They aren't just target practice; they use the same physics and weapons as players, and they will hunt you through the trees if they catch a glimpse of you.

### The Global Express
A massive, high speed train circles the planet on a set track. It is a constant environmental hazard that shares a perfectly synced position for everyone in the game. Getting hit by the train is a death sentence, but watching a bot get launched into orbit by it never gets old.

### Progression and Customization
As you rack up kills, you earn coins that can be spent in the shop. We designed a variety of weapon skins, from clean marble to glowing lava patterns, so you can stand out while you are dominating the leaderboard.

Undersphere is a project born out of a love for tight movement, satisfying physics, and the weirdness of small scale gravity. Step onto the sphere and see for yourself.

Created by Noah Whiteson.

Made for 2026 Vibejam as an AI-assisted game development experiment.
https://vibej.am/2026

Twitter: @_NoahWhiteson
