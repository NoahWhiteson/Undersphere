import './style.css'
import m6x11FontUrl from './assets/m6x11.ttf?url'
import * as THREE from 'three'
import { SceneSetup } from './core/Scene'
import {
  isPhiBlockedByTrainTrack,
  randomPhiThetaClearOfTrainTrack,
} from './core/Utils'
import { InputManager } from './core/Input'
import { LightingSystem } from './systems/Lighting'
import { GrassSystem } from './systems/GrassSystem'
import { TreeSystem, type TreePlacement } from './systems/TreeSystem'
import {
  TrainTrackSystem,
  TRAIN_PLAYER_HIT_COOLDOWN_MS,
  TRAIN_PLAYER_HIT_DAMAGE,
  TRAIN_PLAYER_HIT_KNOCKBACK,
  TRAIN_TRACK_PIECE_ROTATION,
  TRAIN_TRACK_RADIAL_OFFSET,
  TRAIN_VEHICLE_RADIAL_LIFT,
} from './systems/TrainTrackSystem'
import { PlayerController } from './systems/PlayerController'
import { StaminaUI } from './ui/StaminaUI'
import { Crosshair } from './ui/Crosshair'
import { TimerUI } from './ui/TimerUI'
import { FPSCounterUI } from './ui/FPSCounterUI'
import { SettingsUI } from './ui/SettingsUI'
import { HealthUI } from './ui/HealthUI'
import { DamageIndicator } from './ui/DamageIndicator'
import { WeaponUI } from './ui/WeaponUI'
import { KillFeedUI } from './ui/KillFeedUI'
import { MainMenuPlayUI } from './ui/MainMenuPlayUI'
import { MainMenuNavUI } from './ui/MainMenuNavUI'
import { MainMenuDevblogUI } from './ui/MainMenuDevblogUI'
import { MainMenuNameInputUI } from './ui/MainMenuNameInputUI'
import { MainMenuSkinsUI } from './ui/MainMenuSkinsUI'
import { MainMenuStoreUI } from './ui/MainMenuStoreUI'
import { MobileControlsUI } from './ui/MobileControlsUI'
import { loadProfanityList, textContainsProfanity, isProfanityListReady } from './utils/profanityFilter'
import type { AkGunSkinId } from './store/skinEconomy'
import {
  AK_GUN_SKIN_IDS,
  COINS_CHANGED_EVENT,
  getCoins,
  ownsAkGunSkin,
  readEquippedAkSkin,
  setCoins,
} from './store/skinEconomy'
import { BloodSystem } from './systems/BloodSystem'
import { BulletHoleSystem } from './systems/BulletHoleSystem'
import { TargetPlayersSystem, type BotBrainContext } from './systems/TargetPlayersSystem'
import { DamageTextSystem } from './systems/DamageTextSystem'
import { LeaderboardUI, type LeaderboardEntry } from './ui/LeaderboardUI'
import { AnnouncementUI } from './ui/AnnouncementUI'
import { MultiplayerSystem } from './systems/MultiplayerSystem'
import { AnimationManager, type AnimationState } from './systems/AnimationManager'
import { PlayerModel } from './systems/PlayerModel'
import { tryCreateSkeletonRagdoll, type SkeletonRagdoll } from './systems/SkeletonRagdoll'
import { HeldWeapons, exportMuzzleDefaultsPayload } from './systems/HeldWeapons'
import { AmmoSystem, DEFAULT_WEAPON_AMMO_SPECS } from './systems/AmmoSystem'
import { AmmoUI } from './ui/AmmoUI'
import { DeathUI } from './ui/DeathUI'
import { MatchEndUI } from './ui/MatchEndUI'
import { MatchEndSceneShowcase } from './ui/MatchEndSceneShowcase'
import { CoinsHUDUI } from './ui/CoinsHUDUI'
import { RoomIDUI } from './ui/RoomIDUI'
import {
  ECONOMY_RELOADED_EVENT,
  schedulePushCoinsToServer,
  trySyncEconomyFromApi,
} from './net/invertEconomySync'
import { GrenadeSystem } from './systems/GrenadeSystem'
import { parseMuzzleTuningJson, safeParseMuzzleTuning, type MuzzleTuningPayload } from './muzzleTuning'
import { TentSystem } from './systems/TentSystem'
import { BarrierSystem } from './systems/BarrierSystem'
import { WallStepsSystem, type WallStepsPlacement } from './systems/WallStepsSystem'

// Global synchronization state
let initialTrainPhaseForTrain = 0
let trainPhaseSynced = false
let localSyncTimeForTrain = 0

const MULTIPLAYER_WS_URL =
  (import.meta.env.VITE_MULTIPLAYER_URL as string | undefined)?.trim() || 'ws://127.0.0.1:8787'

function readStoredSoloPlayPreference(): boolean {
  try {
    const stored = localStorage.getItem('invert_settings')
    if (!stored) return false
    const data = JSON.parse(stored) as { soloPlay?: unknown }
    return data.soloPlay === true
  } catch {
    return false
  }
}

console.log('Made With ❤️ by Noah Whiteson')


void (async () => {
  try {
    const face = new FontFace('m6x11', `url(${m6x11FontUrl})`, { weight: '400', style: 'normal' })
    await face.load()
    document.fonts.add(face)
  } catch (e) {
    console.warn('[font] m6x11 FontFace failed', e)
  }
  try {
    await document.fonts.load("16px 'm6x11'")
  } catch {
    /* ignore */
  }
})()

function scheduleProfanityListLoad() {
  const run = () => void loadProfanityList()
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(run, { timeout: 5000 })
  } else {
    setTimeout(run, 200)
  }
}
scheduleProfanityListLoad()

window.addEventListener(COINS_CHANGED_EVENT, (ev) => {
  const d = (ev as CustomEvent<{ fromServer?: boolean }>).detail
  if (d?.fromServer) return
  schedulePushCoinsToServer()
})

const COINS_PER_KILL = 10
const HEALTH_PER_KILL = 15
const LOCAL_KILL_REWARD_DEDUPE_MS = 2500
const recentLocalKillRewards = new Map<string, number>()
const recentLocalBotScoreRewards = new Map<string, number>()
const recentKillFeedEntries = new Set<string>()

function awardKillCoins() {
  setCoins(getCoins() + COINS_PER_KILL)
}

function healLocalPlayerOnKill() {
  if (isDead || atMainMenu) return
  player.state.health = Math.min(player.state.maxHealth, player.state.health + HEALTH_PER_KILL, 100)
  lastHealth = player.state.health
}

function grantLocalKillReward(victimKey: string) {
  const now = performance.now()
  for (const [key, at] of recentLocalKillRewards) {
    if (now - at > LOCAL_KILL_REWARD_DEDUPE_MS) recentLocalKillRewards.delete(key)
  }
  if (recentLocalKillRewards.has(victimKey)) return
  recentLocalKillRewards.set(victimKey, now)
  awardKillCoins()
  healLocalPlayerOnKill()
}

function registerLocalBotKillScore(victimKey: string) {
  const now = performance.now()
  for (const [key, at] of recentLocalBotScoreRewards) {
    if (now - at > LOCAL_KILL_REWARD_DEDUPE_MS) recentLocalBotScoreRewards.delete(key)
  }
  if (recentLocalBotScoreRewards.has(victimKey)) return
  recentLocalBotScoreRewards.set(victimKey, now)
  discoveredPlayers.add(victimKey)
  myBotKills++
}

const core = new SceneSetup()
const sphereRadius = 50


const geometry = new THREE.SphereGeometry(sphereRadius, 48, 48)
const material = new THREE.MeshToonMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
})
const mesh = new THREE.Mesh(geometry, material)
mesh.receiveShadow = true
core.scene.add(mesh)

const input = new InputManager()
new LightingSystem(core.scene, sphereRadius)
const grass = new GrassSystem(core.scene, sphereRadius)
const trees = new TreeSystem(core.scene, sphereRadius)
const trainTrack = new TrainTrackSystem(core.scene, sphereRadius)
const tents = new TentSystem(core.scene, sphereRadius)
const barriers = new BarrierSystem(core.scene, sphereRadius)
const wallSteps = new WallStepsSystem(core.scene, sphereRadius)


const player = new PlayerController(core.scene, core.camera, sphereRadius, core.renderer.domElement)

const MENU_CHAR_LOCAL_POS = new THREE.Vector3(0, -0.52, -5.1)
const MENU_CHAR_SKINS_X = 3.45
const menuCharacterHolder = new THREE.Group()
menuCharacterHolder.name = 'menuCharacterHolder'
menuCharacterHolder.position.copy(MENU_CHAR_LOCAL_POS)
menuCharacterHolder.scale.setScalar(3)
core.camera.add(menuCharacterHolder)
const blood = new BloodSystem(core.scene, sphereRadius)
const bulletHoles = new BulletHoleSystem(core.scene, sphereRadius)
const targetPlayers = new TargetPlayersSystem(core.scene, sphereRadius, 4)
const multiplayer = new MultiplayerSystem(core.scene)

const MULTIPLAYER_AFK_MS = 5 * 60 * 1000
let lastMultiplayerActivityMs = performance.now()
const _afkPosScratch = new THREE.Vector3()
const _afkLastWorldPos = new THREE.Vector3()
let afkWorldPosInitialized = false

function bumpMultiplayerActivity() {
  lastMultiplayerActivityMs = performance.now()
}

function tickMultiplayerAfkDisconnect(
  input: InputManager,
  opts: {
    connected: boolean
    soloPlay: boolean
    atMenu: boolean
    dead: boolean
    matchFrozen: boolean
    effectiveLeftDown: boolean
    effectiveRightDown: boolean
  },
) {
  const { connected, soloPlay, atMenu, dead, matchFrozen, effectiveLeftDown, effectiveRightDown } = opts
  if (!connected || soloPlay || atMenu) return

  let activity = false
  if (input.takeIdleLookMotionSq() > 4) activity = true
  if (input.peekWheelDeltaAbs() > 1e-9) activity = true

  const gz = 0.15
  if (
    Math.abs(input.getGamepadAxis(0)) > gz ||
    Math.abs(input.getGamepadAxis(1)) > gz ||
    Math.abs(input.getGamepadAxis(2)) > gz ||
    Math.abs(input.getGamepadAxis(3)) > gz
  ) {
    activity = true
  }

  const keysCheck = [
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'KeyC', 'KeyR',
    'Digit1', 'Digit2', 'Digit3', 'KeyV', 'KeyY', 'MouseLeft',
  ]
  for (let i = 0; i < keysCheck.length; i++) {
    if (input.isKeyDown(keysCheck[i]!)) {
      activity = true
      break
    }
  }

  if (effectiveLeftDown || effectiveRightDown) activity = true

  if (!dead && !matchFrozen) {
    if (!afkWorldPosInitialized) {
      afkWorldPosInitialized = true
      _afkLastWorldPos.copy(player.playerGroup.position)
      activity = true
    } else {
      _afkPosScratch.copy(player.playerGroup.position).sub(_afkLastWorldPos)
      if (_afkPosScratch.lengthSq() > 2.5e-5) activity = true
      _afkLastWorldPos.copy(player.playerGroup.position)
    }
    if (player.state.velocity.lengthSq() > 0.000225) activity = true
  } else {
    afkWorldPosInitialized = false
  }

  if (activity) bumpMultiplayerActivity()

  if (performance.now() - lastMultiplayerActivityMs > MULTIPLAYER_AFK_MS) {
    multiplayer.disconnect()
    bumpMultiplayerActivity()
    afkWorldPosInitialized = false
  }
}

const playerModel = new PlayerModel()
const heldWeapons = new HeldWeapons(core.scene, core.camera, sphereRadius)
const damageTexts = new DamageTextSystem(core.scene)
const leaderboardUI = new LeaderboardUI()
const announcementUI = new AnnouncementUI()
const deathUI = new DeathUI()
const matchEndUI = new MatchEndUI()
const discoveredPlayers = new Set<string>()

function registerBotKill(killerBotIndex: number) {
  targetPlayers.recordBotKill(killerBotIndex)
  discoveredPlayers.add(`bot_${killerBotIndex}`)
}

let myBotKills = 0
/** PvP kills — set from server `killerKills` on each kill (authoritative). */
let myPvpKills = 0
const MAX_USERNAME_CHARS = 10

function makeDefaultUsername(): string {
  return `Player_${Math.floor(100 + Math.random() * 900)}`
}

const SESSION_DEFAULT_USERNAME = makeDefaultUsername()

function clampUsername(raw: string): string {
  const t = raw.trim()
  return (t.length > 0 ? t : SESSION_DEFAULT_USERNAME).slice(0, MAX_USERNAME_CHARS)
}

const _storedName = localStorage.getItem('invert_username')
let myUsername = clampUsername(!_storedName || _storedName === 'You' ? '' : _storedName)
if (_storedName !== myUsername) {
  try {
    localStorage.setItem('invert_username', myUsername)
  } catch {
    /* ignore */
  }
}

function persistMyUsernameToLocalStorage() {
  try {
    localStorage.setItem('invert_username', myUsername)
  } catch {
    /* ignore quota / private mode */
  }
}

function returnToMainMenu() {
  if (atMainMenu) return
  atMainMenu = true
  matchEndedFreeze = false
  matchEndedByDebug = false
  isDead = false
  matchEndTopThreeCache = null
  
  if (matchEndTimeout) {
    clearTimeout(matchEndTimeout)
    matchEndTimeout = null
  }
  
  // Reset local scores
  myBotKills = 0
  myPvpKills = 0
  updateLeaderboard()
  
  // UI resets
  matchEndUI.hide()
  matchEndShowcase.clear()
  mainMenuPlayUI.getPlayButton().style.pointerEvents = 'auto'
  mainMenuPlayUI.setVisible(true)
  mainMenuNavUI.setVisible(true)
  mainMenuDevblogUI.setVisible(true)
  mainMenuNameUI.setVisible(true)
  mainMenuSkinsUI.setVisible(true)
  mainMenuStoreUI.setVisible(true)
  creditsUI.setVisible(false)
  mainMenuPlayUI.setOpacity(1)
  mainMenuNavUI.setOpacity(1)
  mainMenuDevblogUI.setOpacity(1)
  mainMenuNameUI.setOpacity(1)
  mainMenuSkinsUI.setOpacity(1)
  mainMenuStoreUI.setOpacity(1)
  creditsUI.setVisible(false)
  
  // Hide game UI
  leaderboardUI.setVisible(false)
  timerUI.setVisible(false)
  healthUI.setOpacity(0)
  ammoUI.setOpacity(0)
  weaponUI.setOpacity(0)
  killFeed.setOpacity(0)
  crosshair.setVisible(false)
  coinsHUD.setPlayMode(false)
  staminaUI.setSuppressForMenu(true)
  mobileControlsUI.setVisible(false)
  
  // Reset player state
  player.state.health = 100
  player.state.velocity.set(0, 0, 0)
  ammoSystem.refillAllToStarting()
  player.setPointerLockAllowed(false)
  try {
    player.controls.unlock()
  } catch {}
  player.controls.enabled = false
  
  // Return character to menu holder
  if (playerModel.root) {
    menuCharacterHolder.add(playerModel.root)
    playerModel.root.position.set(0, 0, 0)
    playerModel.root.quaternion.set(0, 0, 0, 1)
  }
  playerModel.setOutlineVisible(true)
  playerModel.setCharacterCastShadow(true)

  // Notify server
  multiplayer.update(
    0, player.playerGroup.position, player.playerGroup.quaternion, 
    0, 0, myUsername, 0, 'idle', 0, true, false
  )
  
  // Reset bots
  targetPlayers.resetAll()
  targetPlayers.setSuppressedByRealPlayers(false)
  roomIdUI.setVisible(true)
  syncMainMenuPanelChrome()
}

window.addEventListener('pagehide', persistMyUsernameToLocalStorage)

let lastFirstPlaceId: string | null = null
let isDead = false
let currentFov = 75
/** PvP match timer hit zero: blur overlay, no move/shoot/look until humans drop below 2. */
let matchEndedFreeze = false
let matchEndTopThreeCache: LeaderboardEntry[] | null = null
let matchEndTimeout: ReturnType<typeof setTimeout> | null = null
/** When true, hold end screen even if the match clock is not running (e.g. `game.fireEndRound()` solo). */
let matchEndedByDebug = false
let pendingDebugMatchEnd = false
let deadKillerId: string | null = null


/** After spawn / respawn: no damage from bots / train / grenades / PvP packets (ms). */
const LOCAL_SPAWN_DAMAGE_INVULN_MS = 8000
let localSpawnInvulnUntilMs = 0

function localSpawnDamageInvulnerable(): boolean {
  return atMainMenu || performance.now() < localSpawnInvulnUntilMs
}
;(window as any).globalLocalSpawnInvulnerable = localSpawnDamageInvulnerable
let localPlayerRagdoll: SkeletonRagdoll | undefined = undefined
let respawnFallbackTimer: ReturnType<typeof setTimeout> | null = null

let atMainMenu = true
/** After first full `applyMainMenuView`, only cheap pose snap runs each frame (huge CPU/DOM win). */
let mainMenuFullChromeApplied = false
let mainMenuPlayUI!: MainMenuPlayUI
let mainMenuNavUI!: MainMenuNavUI
let mainMenuDevblogUI!: MainMenuDevblogUI
let mainMenuNameUI!: MainMenuNameInputUI
let mainMenuSkinsUI!: MainMenuSkinsUI
let mainMenuStoreUI!: MainMenuStoreUI
let mainMenuView: 'home' | 'skins' | 'store' | 'credits' = 'home'
let isPlayTransitioning = false
/** Player on inner shell during menu; camera target stays strictly inside the sphere (camera is child of playerGroup). */
const _mainMenuShell = new THREE.Vector3(0, 0, -sphereRadius)
const _menuSpawnUpScratch = new THREE.Vector3()
const _menuCamWorldTarget = new THREE.Vector3()
const _mainMenuBotHint = new THREE.Vector3(0, -38, 0)
const PLAY_MENU_TRANSITION_MS = 880
const _playCamEndPos = new THREE.Vector3(0, 0, 0)
const _playCamEndQuat = new THREE.Quaternion()

/** Menu→game blend driven by main `animate` (single rAF — avoids fighting `player.update` + duplicate simulation). */
let playTransitionPending: {
  resolve: () => void
  startMs: number
  fromPos: THREE.Vector3
  fromQuat: THREE.Quaternion
  toPos: THREE.Vector3
  toQuat: THREE.Quaternion
  fromCamPos: THREE.Vector3
  fromCamQuat: THREE.Quaternion
} | null = null

function advancePlayTransition(): void {
  const p = playTransitionPending
  if (!p) return
  const nowMs = performance.now()
  const t = (nowMs - p.startMs) / PLAY_MENU_TRANSITION_MS
  const tClamped = Math.min(1, t)
  const eased = smoothStep01(tClamped)
  player.playerGroup.position.lerpVectors(p.fromPos, p.toPos, eased)
  player.playerGroup.quaternion.copy(p.fromQuat).slerp(p.toQuat, eased)
  core.camera.position.lerpVectors(p.fromCamPos, _playCamEndPos, eased)
  core.camera.quaternion.copy(p.fromCamQuat).slerp(_playCamEndQuat, eased)
  const ui = playTransitionMenuGameUiOpacities(tClamped)
  applyPlayTransitionUiCrossfade(ui.menu, ui.game)
  if (tClamped >= 1) {
    player.playerGroup.position.copy(p.toPos)
    player.playerGroup.quaternion.copy(p.toQuat)
    core.camera.position.set(0, 0, 0)
    core.camera.quaternion.identity()
    core.camera.rotation.set(0, 0, 0)
    core.camera.up.set(0, 1, 0)
    applyPlayTransitionUiCrossfade(0, 1)
    playTransitionPending = null
    p.resolve()
  }
}

function smoothStep01(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** Stronger ease for opacity (keeps edges soft, middle responsive). */
function smootherStep01(t: number): number {
  const x = THREE.MathUtils.clamp(t, 0, 1)
  return x * x * x * (x * (x * 6 - 15) + 10)
}

/**
 * Overlapping crossfade: menu lingers while HUD rises in, then menu finishes out.
 * Alphas are independent so the middle of the timeline has both partially visible.
 */
function playTransitionMenuGameUiOpacities(linearT: number): { menu: number; game: number } {
  const t = THREE.MathUtils.clamp(linearT, 0, 1)
  const menuPhaseEnd = 0.58
  const gamePhaseStart = 0.2
  const menuOut = smootherStep01(t / menuPhaseEnd)
  const gameIn = smootherStep01((t - gamePhaseStart) / (1 - gamePhaseStart))
  return { menu: 1 - menuOut, game: gameIn }
}

function applyPlayTransitionUiCrossfade(menuOpacity: number, gameOpacity: number) {
  const m = THREE.MathUtils.clamp(menuOpacity, 0, 1)
  const g = THREE.MathUtils.clamp(gameOpacity, 0, 1)
  mainMenuPlayUI.setOpacity(m)
  mainMenuNavUI.setOpacity(m)
  mainMenuDevblogUI.setOpacity(m)
  mainMenuNameUI.setOpacity(m)
  mainMenuSkinsUI.setOpacity(m)
  mainMenuStoreUI.setOpacity(m)
  creditsUI.setVisible(m > 0.1 && mainMenuView === 'credits')
  coinsHUD.setOpacity(m)
  roomIdUI.setVisible(m > 0.1)
  leaderboardUI.setOpacity(g)
  timerUI.setOpacity(g)
  healthUI.setOpacity(g)
  ammoUI.setOpacity(g)
  weaponUI.setOpacity(g)
  killFeed.setOpacity(g)
  crosshair.setOpacity(g)
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!atMainMenu) return
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    if (e.code === 'Space' || e.code === 'Enter') e.preventDefault()
  },
  { passive: false }
)

const SPAWN_OBJECT_CLEARANCE = 2.6
const SPAWN_MAX_ATTEMPTS = 160

function getSpawnCollisionBodies(): Array<{ position: THREE.Vector3; radius: number }> {
  return [
    ...tents.getCollisionBodies(),
    ...barriers.getCollisionBodies(),
    ...wallSteps.getCollisionBodies(),
    ...trees.getCollisionBodies(),
    ...targetPlayers.getCollisionBodies(),
    ...multiplayer.getCollisionBodies(),
  ]
}

function getBotObstacleBodies(excludingBotIndex: number): Array<{ position: THREE.Vector3; radius: number }> {
  const bodies = [
    ...tents.getCollisionBodies(),
    ...barriers.getCollisionBodies(),
    ...wallSteps.getCollisionBodies(),
    ...trees.getCollisionBodies(),
    ...multiplayer.getCollisionBodies(),
  ]
  if (!atMainMenu && !isDead && !matchEndedFreeze) {
    bodies.push({ position: player.playerGroup.position, radius: Math.max(0.55, player.state.currentHeight * 0.34) })
  }
  targetPlayers.appendLiveBotsAsObstacles(bodies, excludingBotIndex)
  return bodies
}

function getSpawnClearance(pos: THREE.Vector3): number {
  let clearance = Infinity
  const bodies = getSpawnCollisionBodies()
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!
    const c = pos.distanceTo(b.position) - b.radius - SPAWN_OBJECT_CLEARANCE
    if (c < clearance) clearance = c
  }
  return clearance
}

function getRandomSpawnPos(radius: number): THREE.Vector3 {
  const out = new THREE.Vector3()
  const best = new THREE.Vector3(0, -radius, 0)
  let bestClearance = -Infinity

  for (let attempt = 0; attempt < SPAWN_MAX_ATTEMPTS; attempt++) {
    const st = randomPhiThetaClearOfTrainTrack(80)
    out.setFromSphericalCoords(radius, st.phi, st.theta)
    const clearance = getSpawnClearance(out)
    if (clearance > bestClearance) {
      best.copy(out)
      bestClearance = clearance
    }
    if (clearance >= 0) return out
  }

  return best
}
  

function finishLocalRespawn(health: number, maxHealth: number, pos?: THREE.Vector3 | null) {
  if (respawnFallbackTimer) {
    clearTimeout(respawnFallbackTimer)
    respawnFallbackTimer = null
  }
  isDead = false
  deadKillerId = null

  if (localPlayerRagdoll) {
    localPlayerRagdoll = undefined
    playerModel.resetPoseAfterRagdoll()
  }

  player.state.health = health
  player.state.maxHealth = maxHealth

  const spawnPos = pos && pos.lengthSq() > 1e-8 ? pos.clone() : getRandomSpawnPos(sphereRadius)
  player.playerGroup.position.copy(spawnPos)
  player.state.velocity.set(0, 0, 0)
  player.resetPhysicsClock()

  core.camera.up.set(0, 1, 0)
  core.camera.quaternion.identity()
  core.camera.rotation.set(0, 0, 0)
  const spawnUp =
    spawnPos.lengthSq() < 1e-8 ? new THREE.Vector3(0, 1, 0) : spawnPos.clone().normalize().multiplyScalar(-1)
  player.playerGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), spawnUp)

  player.state.isThirdPerson = false
  heldWeapons.setThirdPerson(false)
  player.setPointerLockAllowed(true)
  mobileControlsUI.setVisible(true)
  player.controls.enabled = player.controls.isLocked || input.isMobileControlsActive()
  crosshair.setVisible(true)
  leaderboardUI.setVisible(true)
  leaderboardUI.setOpacity(1)
  timerUI.setVisible(true)
  timerUI.setOpacity(1)
  healthUI.setOpacity(1)
  ammoUI.setOpacity(1)
  weaponUI.setOpacity(1)
  killFeed.setOpacity(1)
  staminaUI.setSuppressForMenu(false)
  coinsHUD.setPlayMode(true)
  coinsHUD.setOpacity(1)
  damageIndicator.setLowHealth(false)
  lastHealth = health
  deathUI.hide()
  localSpawnInvulnUntilMs = performance.now() + LOCAL_SPAWN_DAMAGE_INVULN_MS
  ammoSystem.refillAllToStarting()
  for (let s = 0; s < 3; s++) {
    heldWeapons.setModelVisibility(s, true)
  }
}

function onDeathScreenConfirmRespawn() {
  if (multiplayer.isConnected()) {
    multiplayer.sendLocalDeath()
    multiplayer.sendRespawn()
    if (respawnFallbackTimer) clearTimeout(respawnFallbackTimer)
    respawnFallbackTimer = setTimeout(() => {
      if (!isDead) return
      player.setPointerLockAllowed(true)
      finishLocalRespawn(100, 100, null)
      void player.controls.lock()
    }, 1300)
    return
  }
  player.setPointerLockAllowed(true)
  finishLocalRespawn(100, 100, null)
  void player.controls.lock()
}

function safeUnlockPlayerControls() {
  try {
    player.controls.unlock()
  } catch (e) {
    console.warn('[controls] pointer unlock failed; continuing death UI flow', e)
  }
}

function enterDeathUiState() {
  player.setPointerLockAllowed(false)
  safeUnlockPlayerControls()
  mobileControlsUI.setVisible(false)
  crosshair.setVisible(false)
  healthUI.setOpacity(0)
  ammoUI.setOpacity(0)
  weaponUI.setOpacity(0)
  killFeed.setOpacity(0)
  staminaUI.setOpacity(0)
  leaderboardUI.setVisible(false)
  timerUI.setVisible(false)
  coinsHUD.setOpacity(0)
  damageIndicator.setLowHealth(false)
  heldWeapons.setThirdPerson(true)
}

function handleLocalDeathFromBot(botIndex: number) {
  if (isDead) return
  const botEntry = targetPlayers.getTargetList().find((b) => b.id === `bot_${botIndex}`)
  const botName = botEntry?.username ?? 'Bot'
  isDead = true
  deadKillerId = `bot_${botIndex}`
  player.state.health = 0
  if (multiplayer.isConnected()) {
    multiplayer.sendLocalDeath()
  }
  registerBotKill(botIndex)
  updateLeaderboard()

  if (playerModel.root) {
    const impulse = player.state.velocity.clone().multiplyScalar(10)
    localPlayerRagdoll = tryCreateSkeletonRagdoll(playerModel.root, playerModel.anims, impulse)
  }

  enterDeathUiState()
  deathUI.show(botName, 'AK-47', onDeathScreenConfirmRespawn)
}

function handleLocalDeathFromEnvironment(
  hitImpulseDir: THREE.Vector3,
  killerLabel: string,
  weaponLabel: string,
  detailsText: string
) {
  if (isDead) return
  isDead = true
  deadKillerId = null
  player.state.health = 0
  if (multiplayer.isConnected()) {
    multiplayer.sendLocalDeath()
  }

  if (playerModel.root) {
    const impulse =
      hitImpulseDir.lengthSq() > 1e-8
        ? hitImpulseDir.clone().multiplyScalar(14)
        : player.state.velocity.clone().multiplyScalar(10)
    localPlayerRagdoll = tryCreateSkeletonRagdoll(playerModel.root, playerModel.anims, impulse)
  }

  enterDeathUiState()
  deathUI.show(killerLabel, weaponLabel, onDeathScreenConfirmRespawn, { detailsText })
}

function handleLocalDeathFromTrain(hitAwayWorld: THREE.Vector3) {
  handleLocalDeathFromEnvironment(hitAwayWorld, 'Train', 'Train', 'Killed by Train')
}

type MapPropPlacement = {
  phi: number
  theta: number
  scale?: number
  radius?: number
}

const RANDOM_TENT_COUNT = 5
const RANDOM_BARRIER_COUNT = 5
const RANDOM_WALL_STEPS_COUNT = 5
const RANDOM_PROP_CLEARANCE = 13
const TREE_PROP_CLEARANCE = 2.2

function normalizeTheta(theta: number): number {
  const tau = Math.PI * 2
  return ((theta % tau) + tau) % tau
}

function placementWorldPos(item: MapPropPlacement, radius: number, out: THREE.Vector3): THREE.Vector3 {
  return out.setFromSphericalCoords(radius, item.phi, item.theta)
}

function estimatedPropRadius(scale: number, kind: 'tent' | 'barrier' | 'wallSteps' | 'tree'): number {
  if (kind === 'tent') return scale * 35
  if (kind === 'barrier') return scale * 45
  if (kind === 'wallSteps') return Math.max(1.25, scale * 32)
  return Math.max(0.55, scale * 0.48)
}

function isPlacementClear(
  candidate: MapPropPlacement,
  radius: number,
  reserved: MapPropPlacement[],
  extraClearance: number
): boolean {
  if (isPhiBlockedByTrainTrack(candidate.phi)) return false
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  placementWorldPos(candidate, radius, a)
  for (const item of reserved) {
    placementWorldPos(item, radius, b)
    const minDist = (candidate.radius ?? 0) + (item.radius ?? 0) + extraClearance
    if (a.distanceTo(b) < minDist) return false
  }
  return true
}

function createFallbackTreeLayout(
  _count: number,
  radius: number,
  safeZoneRadius: number,
  reserved: MapPropPlacement[] = []
): TreePlacement[] {
  const out: TreePlacement[] = []
  const all = [...reserved]
  const spawnPos = new THREE.Vector3(0, -radius, 0)
  const p = new THREE.Vector3()
  for (let attempt = 0; attempt < 2500 && out.length < _count; attempt++) {
    const st = randomPhiThetaClearOfTrainTrack(120)
    const scale = 1.2 + Math.random() * 2.0
    const item = { phi: st.phi, theta: st.theta, scale, radius: estimatedPropRadius(scale, 'tree') }
    placementWorldPos(item, radius, p)
    if (p.distanceTo(spawnPos) < safeZoneRadius) continue
    if (!isPlacementClear(item, radius, all, TREE_PROP_CLEARANCE)) continue
    out.push({ phi: item.phi, theta: item.theta, scale })
    all.push(item)
  }
  return out
}

function createRandomSpreadLayout(
  count: number,
  radius: number,
  extraClearance: number,
  scale: number,
  kind: 'tent' | 'barrier' | 'wallSteps',
  reserved: MapPropPlacement[] = []
): MapPropPlacement[] {
  const out: MapPropPlacement[] = []
  const all = [...reserved]

  for (let attempt = 0; attempt < 1800 && out.length < count; attempt++) {
    const st = randomPhiThetaClearOfTrainTrack(120)
    const placement = { phi: st.phi, theta: st.theta, scale, radius: estimatedPropRadius(scale, kind) }
    if (!isPlacementClear(placement, radius, all, extraClearance)) continue
    out.push({ ...placement, theta: normalizeTheta(placement.theta) })
    all.push(placement)
  }

  return out
}

function applyRandomMapLayout() {
  const tentsLayout = createRandomSpreadLayout(RANDOM_TENT_COUNT, sphereRadius, RANDOM_PROP_CLEARANCE, 0.05, 'tent')
  const barriersLayout = createRandomSpreadLayout(
    RANDOM_BARRIER_COUNT,
    sphereRadius,
    RANDOM_PROP_CLEARANCE,
    0.075,
    'barrier',
    tentsLayout
  )
  const wallStepsLayout = createRandomSpreadLayout(
    RANDOM_WALL_STEPS_COUNT,
    sphereRadius,
    RANDOM_PROP_CLEARANCE,
    0.08,
    'wallSteps',
    [...tentsLayout, ...barriersLayout]
  ) as WallStepsPlacement[]

  tents.clear()
  for (const item of tentsLayout) tents.spawn(item.phi, item.theta, item.scale)

  barriers.clear()
  for (const item of barriersLayout) barriers.spawn(item.phi, item.theta, item.scale)

  wallSteps.clear()
  for (const item of wallStepsLayout) wallSteps.spawn(item.phi, item.theta, item.scale)

  void trees.init(createFallbackTreeLayout(80, sphereRadius, 8, [...tentsLayout, ...barriersLayout, ...wallStepsLayout]))
}

function buildSortedLeaderboardEntries(): LeaderboardEntry[] {
  const bots = targetPlayers.getTargetList()
  const netPlayers = multiplayer.getAllPlayers()

  const allEntries: LeaderboardEntry[] = [
    ...bots.map((b) => ({
      id: b.id,
      username: b.username,
      kills: discoveredPlayers.has(b.id) ? b.kills : 0,
      rank: 0,
      discovered: discoveredPlayers.has(b.id),
    })),
    ...netPlayers.map((p) => ({
      id: p.id,
      username: p.username,
      kills: p.kills + p.botKills,
      rank: 0,
      discovered: true,
    })),
  ]

  const myEntry: LeaderboardEntry = {
    id: 'me',
    username: myUsername,
    kills: myBotKills + myPvpKills,
    rank: 0,
    isMe: true,
    discovered: true,
  }
  allEntries.push(myEntry)

  allEntries.sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills
    return a.id.localeCompare(b.id)
  })

  allEntries.forEach((e, idx) => (e.rank = idx + 1))
  return allEntries
}

function updateLeaderboard() {
  const allEntries = buildSortedLeaderboardEntries()

  const topOne = allEntries[0]
  if (topOne && topOne.kills > 0) {
    if (lastFirstPlaceId !== topOne.id) {
      if (settingsUI.graphics.killLeaderMsg) {
        playSfx('newKillLeader', 1.0, 'ui')
        announcementUI.show('NEW KILL LEADER')
      }
    }
    lastFirstPlaceId = topOne.id
  } else {
    lastFirstPlaceId = null
  }

  const top3 = allEntries.slice(0, 3)
  const myFinalEntry = allEntries.find((e) => e.isMe)!
  leaderboardUI.update(top3, myFinalEntry)
  multiplayer.setLeaderboardRanks(allEntries.map((e) => ({ id: e.id, rank: e.rank })))
}

// Update leaderboard more frequently for responsiveness
setInterval(updateLeaderboard, 100)

// ── Audio preload (must run before startup Promise.all — initAllSfx reads soundUrls) ──
const soundBuffers = new Map<string, AudioBuffer>()
const soundUrls = {
  ak: new URL('./assets/audio/ak.mp3', import.meta.url).href,
  shotgun: new URL('./assets/audio/shotgun.mp3', import.meta.url).href,
  reload: new URL('./assets/audio/reload.mp3', import.meta.url).href,
  impact: new URL('./assets/audio/impact.mp3', import.meta.url).href,
  explosion: new URL('./assets/audio/explosion.mp3', import.meta.url).href,
  newKillLeader: new URL('./assets/leaderboard/newkillleader.mp3', import.meta.url).href,
  heartbeat: new URL('./assets/audio/heartbeat.mp3', import.meta.url).href,
  oneMinute: new URL('./assets/audio/1 Minute.mp3', import.meta.url).href,
  click: new URL('./assets/audio/click.mp3', import.meta.url).href,
  trainHorn: new URL('./assets/audio/trainhorn.mp3', import.meta.url).href,
}

let audioCtx: AudioContext | null = null
let masterBus: GainNode | null = null
let sfxLoadPromise: Promise<void> | null = null
let trainHornScheduled = false

function ensureAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx
  if (typeof window === 'undefined') return null
  const AudioCtor = window.AudioContext || (window as any).webkitAudioContext
  if (!AudioCtor) return null

  audioCtx = new AudioCtor()
  const limiter = audioCtx.createDynamicsCompressor()
  limiter.threshold.setValueAtTime(-18, audioCtx.currentTime)
  limiter.knee.setValueAtTime(10, audioCtx.currentTime)
  limiter.ratio.setValueAtTime(15, audioCtx.currentTime)
  limiter.attack.setValueAtTime(0.002, audioCtx.currentTime)
  limiter.release.setValueAtTime(0.15, audioCtx.currentTime)

  const bus = audioCtx.createGain()
  bus.gain.setValueAtTime(0.75, audioCtx.currentTime)
  masterBus = bus

  bus.connect(limiter).connect(audioCtx.destination)
  return audioCtx
}

async function loadAudioBuffer(url: string): Promise<AudioBuffer | null> {
  if (!audioCtx) return null
  try {
    const resp = await fetch(url)
    const arrayBuf = await resp.arrayBuffer()
    return await audioCtx.decodeAudioData(arrayBuf)
  } catch (e) {
    console.warn(`[audio] failed to load ${url}`, e)
    return null
  }
}

async function initAllSfx() {
  if (!audioCtx) return
  const tasks = Object.entries(soundUrls).map(async ([key, url]) => {
    const buf = await loadAudioBuffer(url)
    if (buf) soundBuffers.set(key, buf)
  })
  await Promise.all(tasks)
}

function unlockGameAudio() {
  const ctx = ensureAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  sfxLoadPromise ??= initAllSfx()
  void sfxLoadPromise.then(() => initTrainAudio())
  if (!trainHornScheduled) {
    trainHornScheduled = true
    scheduleTrainHorn()
  }
}

if (typeof window !== 'undefined') {
  const unlockOptions = { once: true, capture: true } as AddEventListenerOptions
  window.addEventListener('pointerdown', unlockGameAudio, unlockOptions)
  window.addEventListener('touchstart', unlockGameAudio, unlockOptions)
  window.addEventListener('click', unlockGameAudio, unlockOptions)
  window.addEventListener('keydown', unlockGameAudio, unlockOptions)
}

void Promise.all([
  targetPlayers.init(),
  multiplayer.init(),
  trainTrack.init(),
  tents.init(),
  barriers.init(),
  wallSteps.init(),
  AnimationManager.preloadAll(),
  heldWeapons.loadAll(),
]).then(async () => {
  await bootstrapMuzzleTuningFromDiskAndStorage()
  timerUI.onOneMinuteRemaining = () => playSfx('oneMinute', 1, 'ui')
  applyRandomMapLayout()
  
  multiplayer.onWorldState = (state) => {
    timerUI.setStartTime(state.matchStartTime)
    applyRandomMapLayout()
    if (typeof state.trainPhase === 'number' && !trainPhaseSynced) {
      trainPhaseSynced = true
      initialTrainPhaseForTrain = state.trainPhase
      localSyncTimeForTrain = Date.now()
      trainTrack.setPhase(state.trainPhase)
    }
  }

  updateLeaderboard()
  // Production-ready multiplayer endpoint with local fallback.
  if (!readStoredSoloPlayPreference()) {
    multiplayer.connect(MULTIPLAYER_WS_URL)
  }

  multiplayer.onSessionStats = (pvp, bot) => {
    myPvpKills = pvp
    myBotKills = bot
    updateLeaderboard()
  }
  multiplayer.onPlayerStatsUpdate = () => updateLeaderboard()

  multiplayer.onLocalUsername = (name) => {
    const u = clampUsername(typeof name === 'string' ? name : '')
    myUsername = u
    persistMyUsernameToLocalStorage()
    mainMenuNameUI?.syncValue(u)
    updateLeaderboard()
  }

  multiplayer.onPlayerDamaged = (targetId, damage, attackerId, health, maxHealth) => {
    if (targetId.startsWith('bot_')) {
      if (attackerId !== multiplayer.getLocalPlayerId()) {
        const idx = parseInt(targetId.split('_')[1]!)
        targetPlayers.inflictDirectDamage(idx, damage)
      }
      return
    }

    if (targetId === multiplayer.getLocalPlayerId()) {
      if (localSpawnDamageInvulnerable()) {
        if (typeof maxHealth === 'number') player.state.maxHealth = maxHealth
        if (typeof health === 'number' && health > player.state.health) {
          player.state.health = health
        }
        return
      }
      if (typeof health === 'number') {
        const before = player.state.health
        player.state.health = Math.max(0, health)
        if (typeof maxHealth === 'number') player.state.maxHealth = maxHealth
        if (before > player.state.health) {
          player.inflictDamage(0)
        }
      } else {
        player.inflictDamage(damage)
      }
    }
  }

  multiplayer.onPlayerKilled = (
    targetId,
    attackerId,
    killerName,
    weapon,
    _deathIncoming,
    victimName,
    killerKills,
    killerBotKills
  ) => {
    const isBot = targetId.startsWith('bot_')
    const isMeAttacker = attackerId != null && attackerId === multiplayer.getLocalPlayerId()
    const isMeVictim = targetId === multiplayer.getLocalPlayerId()

    if (isBot) {
      const idx = parseInt(targetId.split('_')[1]!)
      // Ensure bot is marked as killed locally if not already
      targetPlayers.inflictDirectDamage(idx, 999) 
      
      const killKey = `bot_${idx}_${Math.floor(Date.now() / 2000)}`
      if (!recentKillFeedEntries.has(killKey)) {
        recentKillFeedEntries.add(killKey)
        setTimeout(() => recentKillFeedEntries.delete(killKey), 3000)
        const botName = victimName || `BOT-${String(idx + 1).padStart(2, '0')}`
        const weaponLabel = weapon ? weaponLabelFromSlot(slotFromWeaponName(weapon)) : 'Unknown'
        killFeed.push(botName, weaponLabel)
      }
      
      if (isMeAttacker) {
        grantLocalKillReward(targetId)
        registerLocalBotKillScore(targetId)
        if (typeof killerKills === 'number') myPvpKills = killerKills
        if (typeof killerBotKills === 'number') myBotKills = killerBotKills
        updateLeaderboard()
      }
      return
    }

    if (isMeVictim) {
      isDead = true
      deadKillerId = attackerId ?? null
      player.state.health = 0

      if (playerModel.root) {
        const impulse = player.state.velocity.clone().multiplyScalar(10)
        localPlayerRagdoll = tryCreateSkeletonRagdoll(playerModel.root, playerModel.anims, impulse)
      }

      enterDeathUiState()
      deathUI.show(killerName || 'Unknown', weapon || 'Unknown', onDeathScreenConfirmRespawn)
    } else if (isMeAttacker) {
      grantLocalKillReward(targetId)
      if (typeof killerKills === 'number') {
        myPvpKills = killerKills
      } else {
        myPvpKills++
      }
      if (typeof killerBotKills === 'number') {
        myBotKills = killerBotKills
      }
      const killKey = `${targetId}_${Math.floor(Date.now() / 2000)}`
      if (!recentKillFeedEntries.has(killKey)) {
        recentKillFeedEntries.add(killKey)
        setTimeout(() => recentKillFeedEntries.delete(killKey), 3000)
        const victim = victimName ?? multiplayer.getPlayerById(targetId)?.username ?? 'Unknown'
        const weaponLabel = weapon ? (weapon.includes('-') ? weapon : weaponLabelFromSlot(slotFromWeaponName(weapon))) : 'Unknown'
        killFeed.push(victim, weaponLabel)
      }
    } else {
      // Witness: someone else killed someone else
      const killKey = `${targetId}_${Math.floor(Date.now() / 2000)}`
      if (!recentKillFeedEntries.has(killKey)) {
        recentKillFeedEntries.add(killKey)
        setTimeout(() => recentKillFeedEntries.delete(killKey), 3000)
        const victim = victimName ?? multiplayer.getPlayerById(targetId)?.username ?? 'Unknown'
        const weaponLabel = weapon ? (weapon.includes('-') ? weapon : weaponLabelFromSlot(slotFromWeaponName(weapon))) : 'Unknown'
        killFeed.push(victim, weaponLabel)
      }
    }
    updateLeaderboard()
  }

  multiplayer.onPlayerRespawn = (playerId, health, maxHealth, pos) => {
    if (playerId !== multiplayer.getLocalPlayerId()) return
    finishLocalRespawn(health, maxHealth, pos)
  }

  multiplayer.onBloodSpawn = (point, dir, count) => {
    blood.spawn(point, dir, count)
  }

  multiplayer.onRemoteSound = (sound, position, volume) => {
    if (sound === 'ak') {
      playSpatialSfxAt('ak', position, 0.95 * volume, 95, 'gun')
    } else if (sound === 'shotgun') {
      playSpatialSfxAt('shotgun', position, 1.0 * volume, 105, 'gun')
    } else if (sound === 'reload') {
      playSpatialSfxAt('reload', position, 0.85 * volume, 75, 'gun')
    }
  }

  multiplayer.onMatchReset = () => {
    if (matchEndedFreeze) {
      returnToMainMenu()
      return
    }
    matchEndedByDebug = false
    matchEndTopThreeCache = null
    if (matchEndTimeout) {
      clearTimeout(matchEndTimeout)
      matchEndTimeout = null
    }
    matchEndUI.hide()
    matchEndShowcase.clear()
  }

  multiplayer.onRoomId = (id) => {
    roomIdUI.setRoomId(id)
  }
})
function resolveMatchEndPortraitSource(id: string): THREE.Group | null {
  if (id === 'me') {
    return playerModel.root ?? null
  }
  if (id.startsWith('bot_')) {
    const t = targetPlayers.getTargetById(id)
    return t?.model ?? null
  }
  const p = multiplayer.getPlayerById(id)
  return p?.model ?? null
}

const matchEndShowcase = new MatchEndSceneShowcase(core.camera)
matchEndShowcase.setResolver(resolveMatchEndPortraitSource)

void playerModel.init(core.scene).then(() => {
  matchEndShowcase.bustCache()
  if (matchEndTopThreeCache) {
    matchEndShowcase.syncFromEntries(matchEndTopThreeCache)
  }
})

player.onDamage = (_amount, hitDirection) => {
  const p = player.playerGroup.position.clone()
  const direction = hitDirection
    ? hitDirection.clone().normalize()
    : p.clone().normalize().multiplyScalar(-1)
  blood.spawn(p, direction, 15)
}

const staminaUI = new StaminaUI()
const crosshair = new Crosshair()
const timerUI = new TimerUI()
const fpsCounter = new FPSCounterUI()
const ammoUI = new AmmoUI()
const ammoSystem = new AmmoSystem(DEFAULT_WEAPON_AMMO_SPECS)
const settingsUI = new SettingsUI(crosshair)
const mobileControlsUI = new MobileControlsUI(input)
settingsUI.onGraphicsChange = (key, on) => {
  if (key === 'grass') grass.setVisible(on)
  if (key === 'blood') blood.setVisible(on)
  if (key === 'bulletHoles') bulletHoles.setVisible(on)
}
settingsUI.onSoloPlayChange = () => {
  if (settingsUI.soloPlay) {
    multiplayer.disconnect()
  } else {
    multiplayer.connect(MULTIPLAYER_WS_URL)
  }
  bumpMultiplayerActivity()
  updateLeaderboard()
}
settingsUI.syncSystems()
const healthUI = new HealthUI()
const coinsHUD = new CoinsHUDUI()
const damageIndicator = new DamageIndicator()
const weaponUI = new WeaponUI((slot) => {
  if (atMainMenu || isDead || matchEndedFreeze) return
  switchWeaponSlot(slot)
})
const killFeed = new KillFeedUI()
const roomIdUI = new RoomIDUI()

const _worldUp = new THREE.Vector3(0, 1, 0)

/** Cheap every-frame: keep shell pose + menu camera (no DOM, unlock only if pointer is locked). */
function snapMainMenuPose() {
  player.playerGroup.position.copy(_mainMenuShell)
  _menuSpawnUpScratch.copy(_mainMenuShell).normalize().multiplyScalar(-1)
  player.playerGroup.quaternion.setFromUnitVectors(_worldUp, _menuSpawnUpScratch)
  player.state.velocity.set(0, 0, 0)

  player.playerGroup.updateMatrixWorld(true)
  _menuCamWorldTarget.set(0, 4.5, -(sphereRadius - 9))
  core.camera.position.copy(_menuCamWorldTarget)
  player.playerGroup.worldToLocal(core.camera.position)
  core.camera.up.set(0, 1, 0)
  core.camera.lookAt(0, 0, 0)
  player.controls.enabled = false
  player.setPointerLockAllowed(false)
  if (document.pointerLockElement) {
    try {
      player.controls.unlock()
    } catch {
      /* noop */
    }
  }
  heldWeapons.setThirdPerson(true)
}

function applyMainMenuView() {
  snapMainMenuPose()
  try {
    player.controls.unlock()
  } catch {
    /* noop */
  }
  crosshair.setVisible(false)
  healthUI.setOpacity(0)
  ammoUI.setOpacity(0)
  weaponUI.setOpacity(0)
  killFeed.setOpacity(0)
  staminaUI.setSuppressForMenu(true)
  mainMenuPlayUI.setVisible(true)
  mainMenuNavUI.setVisible(true)
  syncMainMenuPanelChrome()
  mainMenuPlayUI.getPlayButton().style.pointerEvents = 'auto'
  mainMenuPlayUI.setOpacity(1)
  mainMenuNavUI.setOpacity(1)
  mainMenuDevblogUI.setOpacity(1)
  mainMenuNameUI.setOpacity(1)
  mainMenuSkinsUI.setOpacity(1)
  mainMenuStoreUI.setOpacity(1)
  leaderboardUI.setVisible(false)
  timerUI.setVisible(false)
  coinsHUD.setPlayMode(false)
  roomIdUI.setVisible(true)
}

const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _v3 = new THREE.Vector3()
const _q1 = new THREE.Quaternion()
const grenadeSystem = new GrenadeSystem(core.scene, sphereRadius, (params) => {
  let playedImpactThisExplosion = false
  playSpatialSfxAt('explosion', params.pos, 1.2, 120, 'explosion')

  // Handle ALL explosion logic here: Damage, Knockback, Visuals
  const distToPlayer = player.playerGroup.position.distanceTo(params.pos)
  const invuln = localSpawnDamageInvulnerable()
  if (!invuln && distToPlayer <= params.damageRadius + 1e-3) {
    const power = 1 - (distToPlayer / params.damageRadius)
    // 10 max damage for self-damage, scaled by distance
    const dmg = params.playerSelfDamage * power
      if (dmg >= 1) {
        player.inflictDamage(dmg)
        if (!playedImpactThisExplosion) {
          playSfx('impact', 1.0, 'impact', true)
          playedImpactThisExplosion = true
        }
      }

    const kbDir = _v1.copy(player.playerGroup.position).sub(params.pos)
    const kbLen = kbDir.length()
    if (kbLen > 1e-5) {
      kbDir.multiplyScalar(1 / kbLen)
    } else {
      kbDir.copy(player.playerGroup.position)
      if (kbDir.lengthSq() > 1e-10) kbDir.normalize()
      else kbDir.set(0, 1, 0)
    }
    player.applyImpulse(_colDelta.copy(kbDir).multiplyScalar(params.knockbackForce * 1.5 * power))
    if (player.state.health <= 0 && !isDead) {
      handleLocalDeathFromEnvironment(kbDir, 'Self', 'Grenade', 'Killed by Grenade')
    }
  }

  // Damage bots
  const bots = targetPlayers.getRaycastTargets()
  const hitIndices = new Set<number>()
  for (const bot of bots) {
    const idx = bot.userData.targetIdx
    if (typeof idx !== 'number' || hitIndices.has(idx)) continue

    bot.getWorldPosition(_v1)
    const d = _v1.distanceTo(params.pos)
    if (d < params.damageRadius) {
      const power = 1 - (d / params.damageRadius)
      const dmg = params.maxDamage * power
      _v1.sub(params.pos).normalize() // diff direction

      const res = targetPlayers.damageFromHitObject(bot, dmg, _v1)
      if (res && res.damaged) {
        hitIndices.add(idx)
        if (!playedImpactThisExplosion) {
          playSfx('impact', 1.0, 'impact', true)
          playedImpactThisExplosion = true
        }
        damageTexts.spawn(res.pos, Math.round(dmg), idx)

        if (res.killed) {
          const victimKey = `bot_${idx}`
          grantLocalKillReward(victimKey)
          registerLocalBotKillScore(victimKey)
          // stats will be synced via player_killed message from server
          updateLeaderboard()
          const killKey = `${victimKey}_${Math.floor(Date.now() / 2000)}`
          if (!recentKillFeedEntries.has(killKey)) {
            recentKillFeedEntries.add(killKey)
            setTimeout(() => recentKillFeedEntries.delete(killKey), 3000)
            killFeed.push(res.name, 'Grenade')
          }
        }

        if (multiplayer.isConnected()) {
          multiplayer.sendDamage(`bot_${idx}`, dmg, 'Grenade', _v1)
        }

        // Ragdoll knockback for bots
        const botObj = targetPlayers.getTargetById(`bot_${idx}`)
        if (botObj?.ragdoll) {
          botObj.ragdoll.applyExternalImpulse(_v1.multiplyScalar(params.knockbackForce * power), params.pos)
        }
      }
    }
  }

  // Damage networked players (multiplayer)
  const netPlayers = multiplayer.getAllPlayers()
  const localId = multiplayer.getLocalPlayerId()
  for (const p of netPlayers) {
    if (p.id === localId) continue
    p.model.getWorldPosition(_v1)
    const d = _v1.distanceTo(params.pos)
    if (d < params.damageRadius) {
      const power = 1 - (d / params.damageRadius)
      _v1.sub(params.pos).normalize() // diff direction
      const finalDmg = params.maxDamage * power
      multiplayer.sendDamage(p.id, finalDmg, 'Grenade', _v1)

      if (!playedImpactThisExplosion) {
        playSfx('impact', 1.0, 'impact', true)
        playedImpactThisExplosion = true
      }

      // Show damage text above head
      const headPos = p.model.position.clone()
      headPos.y += 2.5
      damageTexts.spawn(headPos, Math.round(finalDmg), stringToId(p.id))

      if (p.ragdoll) {
        p.ragdoll.applyExternalImpulse(_v1.multiplyScalar(params.knockbackForce * power), params.pos)
      }
    }
  }
})

const AK_SKIN_TEX_URL: Record<AkGunSkinId, string> = {
  fabric: new URL('./assets/skins/Fabric.jpg', import.meta.url).href,
  marble: new URL('./assets/skins/marble.jpg', import.meta.url).href,
  dragonskin: new URL('./assets/skins/dragonskin.jpg', import.meta.url).href,
  facade: new URL('./assets/skins/Facade.jpg', import.meta.url).href,
  lava: new URL('./assets/skins/lava.jpg', import.meta.url).href,
}
const akGunSkinTextures = new Map<AkGunSkinId, THREE.Texture>()

function getAkGunSkinTexture(id: AkGunSkinId): THREE.Texture {
  const safe: AkGunSkinId = (AK_GUN_SKIN_IDS as readonly string[]).includes(id) ? id : 'fabric'
  const url = AK_SKIN_TEX_URL[safe]
  if (!url) return getAkGunSkinTexture('fabric')
  let t = akGunSkinTextures.get(safe)
  if (!t) {
    const loader = new THREE.TextureLoader()
    t = loader.load(url, (tex) => {
      tex.flipY = false
    })
    t.colorSpace = THREE.SRGBColorSpace
    akGunSkinTextures.set(safe, t)
  }
  return t
}

const WEAPON_SKIN_SLOT_COUNT = 3

function applyDefaultAkGunLook() {
  for (let s = 0; s < WEAPON_SKIN_SLOT_COUNT; s++) {
    playerModel.setThirdPersonGunMap(s, null)
    heldWeapons.setSlotAlbedoTexture(s, null)
  }
}

function applyAkGunSkin(id: AkGunSkinId) {
  const tex = getAkGunSkinTexture(id)
  for (let s = 0; s < WEAPON_SKIN_SLOT_COUNT; s++) {
    playerModel.setThirdPersonGunMap(s, tex)
    heldWeapons.setSlotAlbedoTexture(s, tex)
  }
}

function applyEquippedOwnedAkGunSkin() {
  const eq = readEquippedAkSkin()
  if (eq === 'default' || !ownsAkGunSkin(eq)) {
    applyDefaultAkGunLook()
    return
  }
  applyAkGunSkin(eq)
}

let menuAkGunSkinSynced = false
let wasMainMenuStoreView = false

async function beginPlayFromMenu() {
  if (!atMainMenu || isDead || isPlayTransitioning) return
  isPlayTransitioning = true
  void trySyncEconomyFromApi()
  if (!atMainMenu || isDead) {
    isPlayTransitioning = false
    return
  }
  pendingDebugMatchEnd = false
  matchEndedByDebug = false
  mainMenuFullChromeApplied = false
  player.controls.enabled = false
  mainMenuPlayUI.getPlayButton().style.pointerEvents = 'none'
  playerModel.setVisible(false)
  menuCharacterHolder.visible = false

  const startPos = player.playerGroup.position.clone()
  const startQuat = player.playerGroup.quaternion.clone()
  const startCamPos = core.camera.position.clone()
  const startCamQuat = core.camera.quaternion.clone()
  const spawnPos = getRandomSpawnPos(sphereRadius)
  const spawnUp =
    spawnPos.lengthSq() < 1e-8 ? new THREE.Vector3(0, 1, 0) : spawnPos.clone().normalize().multiplyScalar(-1)
  const endQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), spawnUp)

  leaderboardUI.setVisible(true)
  leaderboardUI.setOpacity(0)
  timerUI.setVisible(true)
  timerUI.setOpacity(0)
  healthUI.setOpacity(0)
  ammoUI.setOpacity(0)
  weaponUI.setOpacity(0)
  killFeed.setOpacity(0)
  crosshair.setOpacity(0)

  await new Promise<void>((resolve) => {
    playTransitionPending = {
      resolve,
      startMs: performance.now(),
      fromPos: startPos.clone(),
      fromQuat: startQuat.clone(),
      toPos: spawnPos.clone(),
      toQuat: endQuat.clone(),
      fromCamPos: startCamPos.clone(),
      fromCamQuat: startCamQuat.clone(),
    }
  })
  atMainMenu = false // State change AFTER transition
  player.state.velocity.set(0, 0, 0)
  player.resetPhysicsClock()

  player.playerGroup.quaternion.copy(endQuat)

  player.state.isThirdPerson = false
  heldWeapons.setThirdPerson(false)
  applyEquippedOwnedAkGunSkin()
  player.state.onGround = true
  player.setPointerLockAllowed(true)
  player.controls.enabled = true
  input.isSimulatedUnlocked = false
  cameraDebugSnapshot('play transition complete, before lock')
  tryAutoLockCursor()
  cameraDebugSnapshot('play transition complete, after lock request')

  staminaUI.setSuppressForMenu(false)
  mainMenuPlayUI.setVisible(false)
  mainMenuNavUI.setVisible(false)
  mainMenuDevblogUI.setVisible(false)
  mainMenuNameUI.setVisible(false)
  mainMenuSkinsUI.setVisible(false)
  mainMenuStoreUI.setVisible(false)
  creditsUI.setVisible(false)
  mainMenuPlayUI.setOpacity(1)
  mainMenuNavUI.setOpacity(1)
  mainMenuDevblogUI.setOpacity(1)
  mainMenuNameUI.setOpacity(1)
  mainMenuSkinsUI.setOpacity(1)
  mainMenuStoreUI.setOpacity(1)
  mainMenuView = 'home'
  
  menuCharacterHolder.position.copy(MENU_CHAR_LOCAL_POS)
  menuCharacterHolder.visible = true
  if (playerModel.root && playerModel.root.parent === menuCharacterHolder) {
    core.scene.add(playerModel.root)
  }
  playerModel.setOutlineVisible(true)
  playerModel.setCharacterCastShadow(true)
  leaderboardUI.setOpacity(1)
  timerUI.setOpacity(1)
  healthUI.setOpacity(1)
  ammoUI.setOpacity(1)
  weaponUI.setOpacity(1)
  killFeed.setOpacity(1)
  crosshair.setVisible(true)
  coinsHUD.setPlayMode(true)
  coinsHUD.setOpacity(1)
  roomIdUI.setVisible(false)
  localSpawnInvulnUntilMs = performance.now() + LOCAL_SPAWN_DAMAGE_INVULN_MS
  ammoSystem.refillAllToStarting()
  for (let s = 0; s < 3; s++) {
  heldWeapons.setModelVisibility(s, true)
  }
  isPlayTransitioning = false
  mobileControlsUI.setVisible(true)
}

mainMenuPlayUI = new MainMenuPlayUI(settingsUI)
mainMenuPlayUI.setOnPlay(() => {
  if (atMainMenu && !isDead) {
    input.isSimulatedUnlocked = false
    player.setPointerLockAllowed(true)
    startPlayCameraDebug('play button')
    tryAutoLockCursor()
    void beginPlayFromMenu()
  }
})

import { CreditsUI } from './ui/CreditsUI'
const creditsUI = new CreditsUI()

mainMenuNavUI = new MainMenuNavUI({
  onHome: () => setMainMenuView('home'),
  onSkins: () => setMainMenuView('skins'),
  onStore: () => setMainMenuView('store'),
  onSettings: () => settingsUI.toggleFromNav(),
  onCredits: () => setMainMenuView('credits'),
}, settingsUI)

mainMenuDevblogUI = new MainMenuDevblogUI()

mainMenuNameUI = new MainMenuNameInputUI(myUsername, (name) => {
  myUsername = clampUsername(name)
  persistMyUsernameToLocalStorage()
  updateLeaderboard()
})

mainMenuSkinsUI = new MainMenuSkinsUI(settingsUI, {
  onAkGunSkinEquip: (skin) => {
    if (skin === 'default') applyDefaultAkGunLook()
    else applyAkGunSkin(skin)
  },
})
mainMenuStoreUI = new MainMenuStoreUI(settingsUI, {
  onSkinSwatchPreview: (skin) => {
    if (skin === 'default') applyDefaultAkGunLook()
    else applyAkGunSkin(skin)
  },
  onGunSkinPurchase: (id) => applyAkGunSkin(id),
})

function refreshEconomyDependentUi() {
  mainMenuStoreUI.refresh()
  mainMenuSkinsUI.refresh()
  settingsUI.refreshAccountUuidLabel()
  if (atMainMenu) applyEquippedOwnedAkGunSkin()
}

void trySyncEconomyFromApi().then(refreshEconomyDependentUi)
window.addEventListener(ECONOMY_RELOADED_EVENT, refreshEconomyDependentUi)

function syncMainMenuPanelChrome() {
  if (!atMainMenu || isDead) return
  const home = mainMenuView === 'home'
  const isStore = mainMenuView === 'store'
  const isCredits = mainMenuView === 'credits'
  mainMenuNameUI.setVisible(home)
  // Hide character holder in credits view
  menuCharacterHolder.visible = !isCredits
  if (home) {
    menuCharacterHolder.position.set(0, MENU_CHAR_LOCAL_POS.y, MENU_CHAR_LOCAL_POS.z)
  } else {
    menuCharacterHolder.position.set(MENU_CHAR_SKINS_X, MENU_CHAR_LOCAL_POS.y, MENU_CHAR_LOCAL_POS.z)
  }
  mainMenuSkinsUI.setVisible(mainMenuView === 'skins')
  mainMenuStoreUI.setVisible(isStore)
  creditsUI.setVisible(isCredits)
  mainMenuDevblogUI.setVisible(home)
  
  // Hide coins HUD in credits view
  coinsHUD.setOpacity(isCredits ? 0 : 1)

  if (wasMainMenuStoreView !== isStore) {
    applyEquippedOwnedAkGunSkin()
  }
  wasMainMenuStoreView = isStore
}

function setMainMenuView(view: 'home' | 'skins' | 'store' | 'credits') {
  mainMenuView = view
  if (typeof mainMenuNavUI !== 'undefined') {
    const focusIndex = view === 'home' ? 0 : view === 'skins' ? 1 : view === 'store' ? 2 : 4
    mainMenuGamepadFocusIndex = focusIndex
    mainMenuNavUI.setGamepadFocusedIndex(focusIndex)
    if (typeof mainMenuPlayUI !== 'undefined') mainMenuPlayUI.setGamepadFocused(false)
  }
  syncMainMenuPanelChrome()
}

type MainMenuGamepadAction = 'home' | 'skins' | 'store' | 'settings' | 'credits' | 'play'
const MAIN_MENU_GAMEPAD_ACTIONS: MainMenuGamepadAction[] = ['home', 'skins', 'store', 'settings', 'credits', 'play']
const MAIN_MENU_GAMEPAD_PLAY_INDEX = MAIN_MENU_GAMEPAD_ACTIONS.indexOf('play')
let mainMenuGamepadFocusIndex = 0
let mainMenuGamepadHorizontalWasDown = false
let mainMenuGamepadVerticalWasDown = false
let mainMenuGamepadAcceptWasDown = false
let mainMenuGamepadCancelWasDown = false

function mainMenuGamepadNavIndexForView(): number {
  return mainMenuView === 'home' ? 0 : mainMenuView === 'skins' ? 1 : mainMenuView === 'store' ? 2 : 4
}

function applyMainMenuGamepadFocusStyles() {
  const onPlay = mainMenuGamepadFocusIndex === MAIN_MENU_GAMEPAD_PLAY_INDEX
  mainMenuNavUI.setGamepadFocusedIndex(onPlay ? null : mainMenuGamepadFocusIndex)
  mainMenuPlayUI.setGamepadFocused(onPlay)
}

function startPlayFromMenuGamepad() {
  input.isSimulatedUnlocked = false
  player.setPointerLockAllowed(true)
  tryAutoLockCursor()
  void beginPlayFromMenu()
}

function activateMainMenuGamepadFocus() {
  const action = MAIN_MENU_GAMEPAD_ACTIONS[mainMenuGamepadFocusIndex] ?? 'home'
  if (action === 'play') {
    if (!settingsUI.isOpen) startPlayFromMenuGamepad()
    return
  }
  if (action === 'home') {
    setMainMenuView('home')
    return
  }
  if (action === 'settings') {
    settingsUI.toggleFromNav()
    return
  }
  setMainMenuView(action)
}

function previewMainMenuGamepadFocus() {
  const action = MAIN_MENU_GAMEPAD_ACTIONS[mainMenuGamepadFocusIndex] ?? 'home'
  if (action === 'play') {
    applyMainMenuGamepadFocusStyles()
    return
  }
  if (action === 'settings') return
  setMainMenuView(action)
}

function handleMainMenuGamepad() {
  if (!input.gamepadConnected || !atMainMenu || isDead || isPlayTransitioning) {
    if (typeof mainMenuNavUI !== 'undefined') mainMenuNavUI.setGamepadFocusedIndex(null)
    if (typeof mainMenuPlayUI !== 'undefined') mainMenuPlayUI.setGamepadFocused(false)
    mainMenuGamepadHorizontalWasDown = false
    mainMenuGamepadVerticalWasDown = false
    mainMenuGamepadAcceptWasDown = false
    mainMenuGamepadCancelWasDown = false
    return
  }

  applyMainMenuGamepadFocusStyles()

  const axisX = input.getGamepadAxis(0)
  const axisY = input.getGamepadAxis(1)
  const left = axisX < -0.55 || input.isGamepadButtonPressed(14) || input.isGamepadButtonPressed(4)
  const right = axisX > 0.55 || input.isGamepadButtonPressed(15) || input.isGamepadButtonPressed(5)
  const horizontal = left || right
  if (horizontal && !mainMenuGamepadHorizontalWasDown) {
    if (mainMenuGamepadFocusIndex === MAIN_MENU_GAMEPAD_PLAY_INDEX) {
      mainMenuGamepadFocusIndex = right ? 0 : MAIN_MENU_GAMEPAD_PLAY_INDEX - 1
    } else {
      const step = right ? 1 : -1
      const navCount = MAIN_MENU_GAMEPAD_PLAY_INDEX
      mainMenuGamepadFocusIndex = (mainMenuGamepadFocusIndex + step + navCount) % navCount
    }
    previewMainMenuGamepadFocus()
  }
  mainMenuGamepadHorizontalWasDown = horizontal

  const up = axisY < -0.55 || input.isGamepadButtonPressed(12)
  const down = axisY > 0.55 || input.isGamepadButtonPressed(13)
  const vertical = up || down
  if (vertical && !mainMenuGamepadVerticalWasDown) {
    if (down) {
      mainMenuGamepadFocusIndex = MAIN_MENU_GAMEPAD_PLAY_INDEX
    } else if (mainMenuGamepadFocusIndex === MAIN_MENU_GAMEPAD_PLAY_INDEX) {
      mainMenuGamepadFocusIndex = mainMenuGamepadNavIndexForView()
    }
    applyMainMenuGamepadFocusStyles()
  }
  mainMenuGamepadVerticalWasDown = vertical

  const accept = input.isGamepadButtonPressed(0) || input.isGamepadButtonPressed(9)
  if (accept && !mainMenuGamepadAcceptWasDown) activateMainMenuGamepadFocus()
  mainMenuGamepadAcceptWasDown = accept

  const cancel = input.isGamepadButtonPressed(1)
  if (cancel && !mainMenuGamepadCancelWasDown && settingsUI.isOpen) settingsUI.toggleFromNav()
  mainMenuGamepadCancelWasDown = cancel
}

void loadProfanityList().then(() => {
  if (!isProfanityListReady() || !textContainsProfanity(myUsername)) return
  myUsername = makeDefaultUsername()
  persistMyUsernameToLocalStorage()
  mainMenuNameUI.syncValue(myUsername)
  updateLeaderboard()
})

settingsUI.registerCursorTargets([
  ...mainMenuNavUI.getButtons(),
  mainMenuPlayUI.getPlayButton(),
  ...mainMenuNameUI.getPointerTargets(),
  ...mainMenuSkinsUI.getPointerTargets(),
  ...mainMenuStoreUI.getPointerTargets(),
])

const raycaster = new THREE.Raycaster()
const muzzleDir = new THREE.Vector3()
const _worldPos = new THREE.Vector3()
const _shotDir = new THREE.Vector3()
const _sphereHitPoint = new THREE.Vector3()
const _entityRayBuffer: THREE.Object3D[] = []
const _worldNormalScratch = new THREE.Vector3()
const _aimAssistTargetPos = new THREE.Vector3()
const _aimAssistToTarget = new THREE.Vector3()
const _aimAssistBestDir = new THREE.Vector3()
const AIM_ASSIST_MAX_ANGLE_RAD = 0.12
const AIM_ASSIST_STRENGTH = 0.22
const AIM_ASSIST_MAX_DISTANCE = 110

/** `dir` must be unit length; returns distance along ray or null. */
function raySphereNearestHitUnit(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  radius: number,
  outPoint: THREE.Vector3
): number | null {
  const rd = origin.dot(dir)
  const c = origin.lengthSq() - radius * radius
  const disc = rd * rd - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  let t = -rd - s
  if (t < 1e-4) t = -rd + s
  if (t < 1e-4) return null
  outPoint.copy(origin).addScaledVector(dir, t)
  return t
}

function pickShootIntersection(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  worldMesh: THREE.Mesh,
  sphereR: number,
  humanPlayers: THREE.Object3D[],
  netPlayers: THREE.Object3D[],
  tents: THREE.Object3D[],
  barriers: THREE.Object3D[],
  wallSteps: THREE.Object3D[],
  trees: THREE.Object3D[]
): THREE.Intersection | null {
  _entityRayBuffer.length = 0
  for (let i = 0; i < humanPlayers.length; i++) _entityRayBuffer.push(humanPlayers[i]!)
  for (let i = 0; i < netPlayers.length; i++) _entityRayBuffer.push(netPlayers[i]!)
  for (let i = 0; i < tents.length; i++) _entityRayBuffer.push(tents[i]!)
  for (let i = 0; i < barriers.length; i++) _entityRayBuffer.push(barriers[i]!)
  for (let i = 0; i < wallSteps.length; i++) _entityRayBuffer.push(wallSteps[i]!)
  for (let i = 0; i < trees.length; i++) _entityRayBuffer.push(trees[i]!)

  raycaster.set(origin, dir)
  const entityHits = raycaster.intersectObjects(_entityRayBuffer, true)
  const tWorld = raySphereNearestHitUnit(origin, dir, sphereR, _sphereHitPoint)

  let best: THREE.Intersection | null = null
  let bestT = Infinity

  if (entityHits.length > 0) {
    best = entityHits[0]!
    bestT = best.distance
  }
  if (tWorld !== null && tWorld < bestT) {
    best = {
      distance: tWorld,
      point: _sphereHitPoint.clone(),
      object: worldMesh,
    } as THREE.Intersection
    bestT = tWorld
  }
  return best
}

function applyTinyAimAssist(origin: THREE.Vector3, dir: THREE.Vector3) {
  const minDot = Math.cos(AIM_ASSIST_MAX_ANGLE_RAD)
  let bestDot = minDot
  let bestDistance = Infinity
  let found = false

  const scan = (targets: THREE.Object3D[]) => {
    for (let i = 0; i < targets.length; i++) {
      const obj = targets[i]
      if (!obj) continue
      obj.getWorldPosition(_aimAssistTargetPos)
      _aimAssistToTarget.copy(_aimAssistTargetPos).sub(origin)
      const dist = _aimAssistToTarget.length()
      if (dist < 2 || dist > AIM_ASSIST_MAX_DISTANCE) continue
      _aimAssistToTarget.multiplyScalar(1 / dist)
      const dot = dir.dot(_aimAssistToTarget)
      if (dot < bestDot) continue
      if (dot === bestDot && dist >= bestDistance) continue
      bestDot = dot
      bestDistance = dist
      found = true
      _aimAssistBestDir.copy(_aimAssistToTarget)
    }
  }

  scan(targetPlayers.getRaycastTargets())
  scan(multiplayer.getRaycastTargets())
  if (!found) return
  dir.lerp(_aimAssistBestDir, AIM_ASSIST_STRENGTH).normalize()
}

const _rayOc = new THREE.Vector3()
const _botAimU = new THREE.Vector3()
const _botAimV = new THREE.Vector3()
const BOT_AK_DAMAGE = 16
/** Extra inaccuracy on top of tangent jitter (wider cone than player AK). */
const BOT_AK_SPREAD = 0.14
const BOT_AK_TANGENT_JITTER = 0.082

function applyBotAimInaccuracy(dir: THREE.Vector3, out: THREE.Vector3) {
  out.copy(dir)
  if (out.lengthSq() < 1e-8) {
    out.set(0, 0, 1)
  } else {
    out.normalize()
  }
  _botAimU.set(1, 0, 0)
  if (Math.abs(out.dot(_botAimU)) > 0.92) _botAimU.set(0, 1, 0)
  _botAimV.crossVectors(out, _botAimU).normalize()
  _botAimU.crossVectors(_botAimV, out).normalize()
  out.addScaledVector(_botAimV, (Math.random() - 0.5) * 2 * BOT_AK_TANGENT_JITTER)
  out.addScaledVector(_botAimU, (Math.random() - 0.5) * 2 * BOT_AK_TANGENT_JITTER)
  out.normalize()
  out.addScaledVector(_botAimV, (Math.random() - 0.5) * 0.028)
  out.addScaledVector(_botAimU, (Math.random() - 0.5) * 0.028)
  out.normalize()
}

/** Ray vs sphere; `rd` unit; returns distance along ray or null. */
function rayIntersectSphereDist(ro: THREE.Vector3, rd: THREE.Vector3, center: THREE.Vector3, r: number): number | null {
  _rayOc.copy(ro).sub(center)
  const b = _rayOc.dot(rd)
  const c = _rayOc.dot(_rayOc) - r * r
  const disc = b * b - c
  if (disc < 0) return null
  const s = Math.sqrt(disc)
  let t = -b - s
  if (t < 1e-4) t = -b + s
  if (t < 1e-4) return null
  return t
}

function tryBotAkHit(botIndex: number, eye: THREE.Vector3, dir: THREE.Vector3) {
  if (settingsUI.isOpen) return

  applyBotAimInaccuracy(dir, _shotDir)
  if (BOT_AK_SPREAD > 0) {
    _shotDir.x += (Math.random() - 0.5) * BOT_AK_SPREAD
    _shotDir.y += (Math.random() - 0.5) * BOT_AK_SPREAD
    _shotDir.z += (Math.random() - 0.5) * BOT_AK_SPREAD
    _shotDir.normalize()
  }
  _worldPos.copy(eye)

  const shooterBot = targetPlayers.getTargetById(`bot_${botIndex}`)
  const soundPos = shooterBot?.container.position ?? eye
  playSpatialSfxAt('ak', soundPos, 0.9, 95, 'gun')
  multiplayer.sendSound('ak', soundPos, 1)

  const botTargets = targetPlayers.getRaycastTargets().filter(
    (o) => typeof o.userData.targetIdx !== 'number' || o.userData.targetIdx !== botIndex
  )
  const netTargets = multiplayer.getRaycastTargets()
  const h = pickShootIntersection(_worldPos, _shotDir, mesh, sphereRadius, botTargets, netTargets, tents.getRaycastTargets(), barriers.getRaycastTargets(), wallSteps.getRaycastTargets(), trees.getRaycastTargets())
  const hitDist = h?.distance ?? Infinity

  const spawnGraceActive = localSpawnDamageInvulnerable()
  let tPlayer: number | null = null
  if (!isDead && !spawnGraceActive) {
    tPlayer = rayIntersectSphereDist(_worldPos, _shotDir, player.playerGroup.position, 0.72)
  }

  if (tPlayer !== null && tPlayer < hitDist) {
    const incoming = _tmpKb.copy(_shotDir).multiplyScalar(-1).normalize()
    player.inflictDamage(BOT_AK_DAMAGE, incoming)
    playSfx('impact', 0.85, 'impact')
    const headPos = player.playerGroup.position.clone()
    const dmgUp = headPos.clone().normalize().multiplyScalar(-1)
    headPos.addScaledVector(dmgUp, 1.2)
    damageTexts.spawn(headPos, Math.round(BOT_AK_DAMAGE), stringToId('local_player_dmg'))
    if (player.state.health <= 0) handleLocalDeathFromBot(botIndex)
    return
  }

  if (!h) return

  if (h.object === mesh || h.object.name.toLowerCase().includes('tent') || h.object.parent?.name.toLowerCase().includes('tent')) {
    const normal = h.face
      ? _worldNormalScratch.copy(h.face.normal).applyQuaternion(h.object.quaternion)
      : _worldNormalScratch.copy(h.point).normalize()
    bulletHoles.spawn(h.point, normal)
    return
  }

  if (h.object.userData.networkPlayerId) {
    const targetId = h.object.userData.networkPlayerId as string
    const hitDir = _v1.copy(_shotDir).negate().normalize()
    playSfx('impact', 1.0, 'impact')
    blood.spawn(h.point, hitDir, 4)
    multiplayer.sendBlood(h.point, hitDir, 4)
    multiplayer.sendDamage(targetId, BOT_AK_DAMAGE, 'AK-47', _shotDir, { fromBot: true })
    const tp = multiplayer.getPlayerById(targetId)
    if (tp?.ragdoll) {
      tp.ragdoll.applyExternalImpulse(_colDelta.copy(_shotDir).multiplyScalar(0.1), h.point)
    }
    if (tp) {
      const headPos = new THREE.Vector3()
      tp.model.getWorldPosition(headPos)
      headPos.y += 2.5
      damageTexts.spawn(headPos, BOT_AK_DAMAGE, stringToId(targetId))
    }
    return
  }

  const hitDir = _v1.copy(_shotDir).negate().normalize()
  const damageRes = targetPlayers.damageFromHitObject(h.object as THREE.Mesh, BOT_AK_DAMAGE, _shotDir)
  if (!damageRes?.damaged) return
  playSpatialSfxAt('impact', h.point, 0.4, 48, 'impact')
  blood.spawn(h.point, hitDir, 4)
  multiplayer.sendBlood(h.point, hitDir, 4)
  damageTexts.spawn(damageRes.pos, BOT_AK_DAMAGE, damageRes.targetIdx)
  const victim = targetPlayers.getTargetById(`bot_${damageRes.targetIdx}`)
  if (victim?.ragdoll) {
    victim.ragdoll.applyExternalImpulse(_colDelta.copy(_shotDir).multiplyScalar(0.12), h.point)
  }
  if (damageRes.killed) {
    registerBotKill(botIndex)
    discoveredPlayers.add(`bot_${damageRes.targetIdx}`)
    updateLeaderboard()
  }
}

const _tmpKb = new THREE.Vector3()
const _colDelta = new THREE.Vector3()
const _boxLocalCenter = new THREE.Vector3()
const _boxClosest = new THREE.Vector3()
const _boxLocalNormal = new THREE.Vector3()
const _boxWorldNormal = new THREE.Vector3()
const _boxInvQuat = new THREE.Quaternion()
const _trainHitAway = new THREE.Vector3()

let lastTrainPlayerHitMs = -Infinity
const lastTrainBotHitMs: number[] = new Array(12).fill(-Infinity)
let isLeftMouseDown = false
let isRightMouseDown = false
let isLeftMouseDownOnGamepad = false
let isRightMouseDownOnGamepad = false
let wasLeftMouseDownLastFrame = false
let grenadeCharge = 0

const SHOTGUN_SLOT = 1
const GRENADE_SLOT = 2
const AK_SLOT = 0
const RELOAD_MS = 2000
const RELOAD_FINISH_PROGRESS = 0.99
let shotgunMidairKnockbackUsed = false
let isReloading = false
let reloadSlot = -1
let reloadStartedAt = 0

// Looping heartbeat state
let heartbeatSource: AudioBufferSourceNode | null = null
let heartbeatGain: GainNode | null = null

function updateHeartbeatByHealth(health: number, maxHealth: number) {
  if (!audioCtx || !masterBus) return
  const buf = soundBuffers.get('heartbeat')
  if (!buf) return

  if (isDead) {
    if (heartbeatGain) heartbeatGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1)
    return
  }

  const hp01 = Math.max(0, Math.min(1, health / Math.max(1, maxHealth)))
  const low = 1 - hp01
  const master = settingsUI.volumes.master

  if (low < 0.25) {
    if (heartbeatGain) heartbeatGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2)
    return
  }

  if (!heartbeatSource) {
    const src = audioCtx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const g = audioCtx.createGain()
    g.gain.value = 0
    src.connect(g).connect(masterBus)
    src.start()
    heartbeatSource = src
    heartbeatGain = g
  }

  const t = (low - 0.25) / 0.75
  const targetVol = (0.1 + t * 0.7) * master
  if (heartbeatGain) heartbeatGain.gain.setTargetAtTime(targetVol, audioCtx.currentTime, 0.1)
  if (heartbeatSource) heartbeatSource.playbackRate.setTargetAtTime(1 + t * 0.8, audioCtx.currentTime, 0.1)
}

// SFX management
const voiceCount = new Map<string, number>()
const lastTriggerTime = new Map<string, number>()
const MAX_VOICES_PER_TYPE = 12
const MIN_RETRIGGER_GAP_MS = 40

function playSfx(
  key: string,
  volume: number = 1.0,
  type: 'master' | 'gun' | 'impact' | 'explosion' | 'ui' = 'master',
  bypassLimit: boolean = false
) {
  if (!audioCtx || !masterBus) return
  const buf = soundBuffers.get(key)
  if (!buf) return

  const now = performance.now()
  const lastTime = lastTriggerTime.get(key) ?? 0
  if (!bypassLimit && now - lastTime < MIN_RETRIGGER_GAP_MS) return
  lastTriggerTime.set(key, now)

  const currentCount = voiceCount.get(type) ?? 0
  if (!bypassLimit && currentCount >= MAX_VOICES_PER_TYPE) return

  const source = audioCtx.createBufferSource()
  source.buffer = buf
  
  const gain = audioCtx.createGain()
  const master = settingsUI.volumes.master
  const typeVol = settingsUI.volumes[type]
  gain.gain.value = Math.max(0, Math.min(1.5, volume * master * typeVol))
  
  source.connect(gain).connect(masterBus)
  
  voiceCount.set(type, currentCount + 1)
  source.onended = () => {
    voiceCount.set(type, Math.max(0, (voiceCount.get(type) ?? 1) - 1))
    source.disconnect()
    gain.disconnect()
  }

  source.start()
}

function playSpatialSfxAt(
  key: string,
  sourcePos: THREE.Vector3,
  baseVolume: number = 1.0,
  maxDistance: number = 80,
  type: 'master' | 'gun' | 'impact' | 'explosion' | 'ui' = 'master',
  bypassLimit: boolean = false
) {
  if (!audioCtx || !masterBus) return
  const buf = soundBuffers.get(key)
  if (!buf) return

  const now = performance.now()
  const lastTime = lastTriggerTime.get(key) ?? 0
  if (!bypassLimit && now - lastTime < MIN_RETRIGGER_GAP_MS) return
  lastTriggerTime.set(key, now)

  const currentCount = voiceCount.get(type) ?? 0
  if (!bypassLimit && currentCount >= MAX_VOICES_PER_TYPE) return

  const source = audioCtx.createBufferSource()
  source.buffer = buf

  const panner = audioCtx.createPanner()
  panner.panningModel = 'HRTF'
  panner.distanceModel = 'inverse'
  panner.refDistance = 5
  panner.maxDistance = maxDistance
  panner.rolloffFactor = 1.8 
  panner.positionX.value = sourcePos.x
  panner.positionY.value = sourcePos.y
  panner.positionZ.value = sourcePos.z

  const gain = audioCtx.createGain()
  const master = settingsUI.volumes.master
  const typeVol = settingsUI.volumes[type]
  gain.gain.value = Math.max(0, Math.min(1.5, baseVolume * master * typeVol))

  source.connect(gain).connect(panner).connect(masterBus)

  voiceCount.set(type, currentCount + 1)
  source.onended = () => {
    voiceCount.set(type, Math.max(0, (voiceCount.get(type) ?? 1) - 1))
    source.disconnect()
    gain.disconnect()
    panner.disconnect()
  }

  source.start()
}

function updateAudioListener() {
  if (!audioCtx) return
  const camPos = _v1.setFromMatrixPosition(core.camera.matrixWorld)
  const camQuat = _q1.setFromRotationMatrix(core.camera.matrixWorld)
  const forward = _v2.set(0, 0, -1).applyQuaternion(camQuat)
  const up = _v3.set(0, 1, 0).applyQuaternion(camQuat)
  
  const listener = audioCtx.listener
  const time = audioCtx.currentTime
  if (listener.positionX) {
    listener.positionX.setTargetAtTime(camPos.x, time, 0.05)
    listener.positionY.setTargetAtTime(camPos.y, time, 0.05)
    listener.positionZ.setTargetAtTime(camPos.z, time, 0.05)
    listener.forwardX.setTargetAtTime(forward.x, time, 0.05)
    listener.forwardY.setTargetAtTime(forward.y, time, 0.05)
    listener.forwardZ.setTargetAtTime(forward.z, time, 0.05)
    listener.upX.setTargetAtTime(up.x, time, 0.05)
    listener.upY.setTargetAtTime(up.y, time, 0.05)
    listener.upZ.setTargetAtTime(up.z, time, 0.05)
  } else {
    listener.setPosition(camPos.x, camPos.y, camPos.z)
    listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z)
  }
}

// Expose for other modules
;(window as any).playSfx = playSfx
;(window as any).playSpatialSfxAt = playSpatialSfxAt

// ── Train Spatial Audio ────────────────────────────────────────────────────
const TRAIN_CROSSFADE_AT = 4.0
const TRAIN_LOOP_DUR    = 6.0
const TRAIN_MAX_DIST    = 35
const TRAIN_BASE_VOL    = 0.35

let trainAmbientGain: GainNode | null = null
let trainAudioBuf: AudioBuffer | null = null
let trainAudioReady = false

function _scheduleTrainLoop(startAt: number) {
  if (!audioCtx || !trainAudioBuf || !trainAmbientGain) return
  const gain = trainAmbientGain
  const src = audioCtx.createBufferSource()
  src.buffer = trainAudioBuf
  src.connect(gain)
  src.start(startAt, 0)
  src.stop(startAt + TRAIN_LOOP_DUR)

  const nextStart = startAt + TRAIN_CROSSFADE_AT
  const msTill = (nextStart - audioCtx.currentTime) * 1000 - 50
  setTimeout(() => {
    if (!trainAudioReady || !trainAmbientGain) return
    _scheduleTrainLoop(nextStart)
  }, Math.max(0, msTill))
}

async function initTrainAudio() {
  if (!audioCtx || trainAudioReady) return
  try {
    const resp = await fetch(new URL('./assets/audio/train.mp3', import.meta.url).href)
    const arrayBuf = await resp.arrayBuffer()
    trainAudioBuf = await audioCtx.decodeAudioData(arrayBuf)
    const gainNode = audioCtx.createGain()
    gainNode.gain.value = 0
    if (masterBus) gainNode.connect(masterBus)
    else gainNode.connect(audioCtx.destination)
    trainAmbientGain = gainNode
    trainAudioReady = true
    _scheduleTrainLoop(audioCtx.currentTime)
  } catch (e) {
    console.warn('[train audio] init failed', e)
  }
}

function playTrainHornSpatial(trainPos: THREE.Vector3) {
  if (!settingsUI.graphics.trainNoise) return
  playSpatialSfxAt('trainHorn', trainPos, 0.9, 250, 'master')
}

let lastTrainHornMs = -Infinity
function scheduleTrainHorn() {
  const delay = 30000 + Math.random() * 30000
  setTimeout(() => {
    const now = performance.now()
    if (now - lastTrainHornMs >= 30000 && settingsUI.graphics.trainNoise) {
      lastTrainHornMs = now
      const trainPos = new THREE.Vector3()
      if (trainTrack.getTrainFrontWorldPosition(trainPos)) {
        playTrainHornSpatial(trainPos)
      }
    }
    scheduleTrainHorn()
  }, delay)
}

const _trainCamPos = new THREE.Vector3()
const _trainPos = new THREE.Vector3()
function updateTrainSpatialAudio() {
  if (!trainAmbientGain || !trainAudioReady) return
  if (!settingsUI.graphics.trainNoise) {
    trainAmbientGain.gain.value = 0
    return
  }
  if (!trainTrack.getTrainFrontWorldPosition(_trainPos)) {
    trainAmbientGain.gain.value = 0
    return
  }
  core.camera.getWorldPosition(_trainCamPos)
  const dist = _trainCamPos.distanceTo(_trainPos)
  const norm = dist / Math.max(1, TRAIN_MAX_DIST)
  const atten = 1 / (1 + norm * norm * 6)
  const target = TRAIN_BASE_VOL * atten * settingsUI.volumes.master
  trainAmbientGain.gain.setTargetAtTime(Math.max(0, target), audioCtx!.currentTime, 0.08)
}

function createFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30)
  g.addColorStop(0, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  return tex
}

const FLASH_DISTANCE_FROM_PLAYER = 0.9
const FLASH_OFFSET_X = 0.13
const FLASH_OFFSET_Y = -0.1
const MUZZLE_FLASH_BASE_SCALE = 0.21
const muzzleFlashTuning = {
  scale: MUZZLE_FLASH_BASE_SCALE,
  flipX: false,
}
const muzzleFlashOffsetLocal = new THREE.Vector3(0, 0, 0)

function applyMuzzleSpriteTuningFromPayload(sprite: MuzzleTuningPayload['sprite'] | undefined) {
  if (!sprite) return
  if (typeof sprite.scale === 'number' && Number.isFinite(sprite.scale) && sprite.scale > 0) {
    muzzleFlashTuning.scale = sprite.scale
  }
  if (typeof sprite.flipX === 'boolean') muzzleFlashTuning.flipX = sprite.flipX
  const ol = sprite.offsetLocal
  if (
    Array.isArray(ol) &&
    ol.length === 3 &&
    ol.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    muzzleFlashOffsetLocal.set(ol[0]!, ol[1]!, ol[2]!)
  }
}

function applyMuzzleTuningFromPayload(payload: MuzzleTuningPayload) {
  heldWeapons.applyMuzzleTuningPayload(payload)
  applyMuzzleSpriteTuningFromPayload(payload.sprite)
  syncMuzzleFlashParent()
}

async function bootstrapMuzzleTuningFromDiskAndStorage() {
  let payload: MuzzleTuningPayload | null = null
  try {
    const ls = localStorage.getItem('invert_muzzle_tuning')
    if (ls) payload = parseMuzzleTuningJson(ls)
  } catch {
    /* noop */
  }
  if (!payload) {
    try {
      const res = await fetch('/muzzle-tuning.json', { cache: 'no-store' })
      if (res.ok) payload = safeParseMuzzleTuning(await res.json())
    } catch {
      /* noop */
    }
  }
  if (payload) applyMuzzleTuningFromPayload(payload)
}

const muzzleFlash = new THREE.Sprite(
  new THREE.SpriteMaterial({
    map: createFlashTexture(),
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    depthTest: false,
  })
)
muzzleFlash.name = 'muzzleFlashSprite'
muzzleFlash.visible = false
muzzleFlash.renderOrder = 10
muzzleFlash.scale.set(MUZZLE_FLASH_BASE_SCALE, MUZZLE_FLASH_BASE_SCALE, 1)
muzzleFlash.position.set(FLASH_OFFSET_X, FLASH_OFFSET_Y, -FLASH_DISTANCE_FROM_PLAYER)
core.camera.add(muzzleFlash)
let muzzleFlashLife = 0

function syncMuzzleFlashParent() {
  const anchor = heldWeapons.getMuzzleFlashAnchor()
  const cfg = heldWeapons.currentConfig
  if (anchor && cfg) {
    if (muzzleFlash.parent !== anchor) {
      anchor.add(muzzleFlash)
    }
    muzzleFlash.position.copy(muzzleFlashOffsetLocal)
    const inv = 1 / heldWeapons.getCurrentFpUniformScale()
    const sx = muzzleFlashTuning.scale * inv * (muzzleFlashTuning.flipX ? -1 : 1)
    muzzleFlash.scale.set(sx, muzzleFlashTuning.scale * inv, 1)
  } else {
    if (muzzleFlash.parent !== core.camera) {
      core.camera.add(muzzleFlash)
    }
    muzzleFlash.position.set(FLASH_OFFSET_X, FLASH_OFFSET_Y, -FLASH_DISTANCE_FROM_PLAYER)
    const sx = muzzleFlashTuning.scale * (muzzleFlashTuning.flipX ? -1 : 1)
    muzzleFlash.scale.set(sx, muzzleFlashTuning.scale, 1)
  }
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 0) isLeftMouseDown = true
  if (e.button === 2) isRightMouseDown = true
})
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) isLeftMouseDown = false
  if (e.button === 2) isRightMouseDown = false
})
window.addEventListener('contextmenu', (e) => e.preventDefault())

function stringToId(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

function weaponLabelFromSlot(slot: number): string {
  if (slot === AK_SLOT) return 'AK-47'
  if (slot === SHOTGUN_SLOT) return 'Shotgun'
  if (slot === GRENADE_SLOT) return 'Grenade'
  return 'Unknown'
}

function switchWeaponSlot(slot: number, playClick: boolean = true) {
  const next = Math.max(0, Math.min(2, slot))
  const changed = heldWeapons.getActiveSlot() !== next
  weaponUI.updateActiveSlot(next)
  heldWeapons.setActiveSlot(next)
  if (next === GRENADE_SLOT) {
    const st = ammoSystem.getState(GRENADE_SLOT)
    heldWeapons.setModelVisibility(GRENADE_SLOT, (st?.mag ?? 0) > 0)
  }
  if (changed && playClick) playSfx('click', 0.65, 'ui')
}

function slotFromWeaponName(name: string): number {
  const n = name.toLowerCase()
  if (n.includes('ak')) return AK_SLOT
  if (n.includes('shotgun')) return SHOTGUN_SLOT
  if (n.includes('grenade')) return GRENADE_SLOT
  return 0
}

function shoot() {
  if (isDead) return
  if (matchEndedFreeze) return
  if (settingsUI.isOpen || input.isSimulatedUnlocked) return

  const cfg = heldWeapons.currentConfig
  if (!cfg || !heldWeapons.canFire(performance.now())) return
  const slot = heldWeapons.getActiveSlot()
  if (isReloading && slot < 3) return
  if (slot < 3 && !ammoSystem.tryConsume(slot)) return

  const cam = core.camera
  cam.getWorldPosition(_worldPos)
  cam.getWorldDirection(muzzleDir)
  applyTinyAimAssist(_worldPos, muzzleDir)

  heldWeapons.triggerFire(performance.now())
  if (slot !== GRENADE_SLOT && playerModel.anims) {
    playerModel.anims.triggerFire(cfg.fireRate)
  }
  if (slot === SHOTGUN_SLOT) {
    playSfx('shotgun', 1.0, 'gun', true)
    multiplayer.sendSound('shotgun', player.playerGroup.position, 1)
  }
  if (slot === AK_SLOT) {
    playSfx('ak', 1.0, 'gun', true)
    multiplayer.sendSound('ak', player.playerGroup.position, 1)
  }

  // No muzzle flash or bullet logic for grenades (they are thrown instead)
  if (slot === GRENADE_SLOT) {
    return
  }

  // Restore muzzle flash for non-grenade weapons
  syncMuzzleFlashParent()
  muzzleFlash.visible = true
  muzzleFlashLife = 0.035
  muzzleFlash.material.rotation = Math.random() * Math.PI * 2

  // Recoil shake
  player.state.shakeIntensity = Math.min(0.1, player.state.shakeIntensity + (cfg.damage / 100) * 0.3)

  // Apply knockback to player: Pure opposite direction of view
  if (cfg.knockback) {
    const isShotgun = slot === SHOTGUN_SLOT
    const inAir = !player.state.onGround
    let applyKnockback = true
    if (isShotgun && inAir && shotgunMidairKnockbackUsed) {
      applyKnockback = false
    }
    if (applyKnockback) {
      _tmpKb.copy(muzzleDir).multiplyScalar(-cfg.knockback)
      player.applyImpulse(_tmpKb)
      if (isShotgun && inAir) shotgunMidairKnockbackUsed = true
    }
  }

  // Shooting logic
  const shotCount = cfg.shells || 1
  let playedImpactThisShot = false

  for (let i = 0; i < shotCount; i++) {
    // Per-shot direction with spread (tighter when ADS)
    _shotDir.copy(muzzleDir)
    if (cfg.spread > 0) {
      const spreadMul = player.state.isAiming ? 0.32 : 1
      _shotDir.x += (Math.random() - 0.5) * cfg.spread * spreadMul
      _shotDir.y += (Math.random() - 0.5) * cfg.spread * spreadMul
      _shotDir.z += (Math.random() - 0.5) * cfg.spread * spreadMul
      _shotDir.normalize()
    }
    const targets = targetPlayers.getRaycastTargets()
    const netTargets = multiplayer.getRaycastTargets()
    const h = pickShootIntersection(_worldPos, _shotDir, mesh, sphereRadius, targets, netTargets, tents.getRaycastTargets(), barriers.getRaycastTargets(), wallSteps.getRaycastTargets(), trees.getRaycastTargets())

    if (h) {
      if (h.object === mesh || !h.object.userData.networkPlayerId) {
        // If it's a bot, it will be handled by targetPlayers.damageFromHitObject below.
        // If it's the world or a tent (or anything else), spawn a hole.
        const hitDir = _v1.copy(_shotDir).negate().normalize()
        const damageRes = targetPlayers.damageFromHitObject(h.object, cfg.damage, _shotDir)
        
        if (damageRes && damageRes.damaged) {
          // It was a bot, handle accordingly...
          // (Moving the existing bot damage logic here for clarity)
          const bot = targetPlayers.getTargetById(`bot_${damageRes.targetIdx}`)
          if (bot?.ragdoll) {
            bot.ragdoll.applyExternalImpulse(_colDelta.copy(_shotDir).multiplyScalar(cfg.knockback || 0.1), h.point)
          }

          if (!playedImpactThisShot) {
            playSfx('impact', 1.0, 'impact', true)
            playedImpactThisShot = true
          }
          blood.spawn(h.point, hitDir, 4)
          multiplayer.sendBlood(h.point, hitDir, 4)
          damageTexts.spawn(damageRes.pos, cfg.damage, damageRes.targetIdx)
          crosshair.triggerHit()

          if (damageRes.killed) {
            const victimKey = `bot_${damageRes.targetIdx}`
            grantLocalKillReward(victimKey)
            registerLocalBotKillScore(victimKey)
            // stats will be synced via player_killed message from server
            updateLeaderboard()
            const killKey = `${victimKey}_${Math.floor(Date.now() / 2000)}`
            if (!recentKillFeedEntries.has(killKey)) {
              recentKillFeedEntries.add(killKey)
              setTimeout(() => recentKillFeedEntries.delete(killKey), 3000)
              killFeed.push(damageRes.name, weaponLabelFromSlot(slot))
            }
          }
          if (multiplayer.isConnected()) {
            multiplayer.sendDamage(`bot_${damageRes.targetIdx}`, cfg.damage, weaponLabelFromSlot(slot), _shotDir)
          }
        } else if (h.object === mesh || h.object.name.toLowerCase().includes('tent') || h.object.parent?.name.toLowerCase().includes('tent')) {
          // World or Tent hit
          const normal = h.face
            ? _worldNormalScratch.copy(h.face.normal).applyQuaternion(h.object.quaternion)
            : _worldNormalScratch.copy(h.point).normalize()
          bulletHoles.spawn(h.point, normal)
        }
      } else if (h.object.userData.networkPlayerId) {
        // Hit a networked player
        const targetId = h.object.userData.networkPlayerId
        const hitDir = _v1.copy(_shotDir).negate().normalize()

        if (!playedImpactThisShot) {
          playSfx('impact', 1.0, 'impact', true)
          playedImpactThisShot = true
        }

        blood.spawn(h.point, hitDir, 4)
        multiplayer.sendBlood(h.point, hitDir, 4)
        multiplayer.sendDamage(targetId, cfg.damage, weaponLabelFromSlot(slot), _shotDir)
        crosshair.triggerHit()

        // Apply ragdoll knockback if they are dead
        const targetPlayer = multiplayer.getPlayerById(targetId)
        if (targetPlayer?.ragdoll) {
          targetPlayer.ragdoll.applyExternalImpulse(_colDelta.copy(_shotDir).multiplyScalar(cfg.knockback || 0.1), h.point)
        }

        // Show damage text above their head
        const p = multiplayer.getPlayerById(targetId)
        if (p) {
          const headPos = new THREE.Vector3()
          p.model.getWorldPosition(headPos)
          headPos.y += 2.5
          damageTexts.spawn(headPos, cfg.damage, stringToId(targetId))
        }
      }
    }
  }
}

function getGrenadeThrowParams(charge: number) {
  const cfg = heldWeapons.currentConfig
  if (!cfg) return null

  const cam = core.camera
  cam.getWorldPosition(_worldPos)
  cam.getWorldDirection(muzzleDir)

  // Grenade Aim Assist: Find nearby bots/players to slightly bias the throw
  let bestTargetPos: THREE.Vector3 | null = null
  let bestScore = -Infinity
  const bodies = [
    ...targetPlayers.getCollisionBodies(),
    ...multiplayer.getCollisionBodies()
  ]
  for (const b of bodies) {
    _v2.copy(b.position).sub(_worldPos).normalize()
    const dot = muzzleDir.dot(_v2)
    // Only bias if target is roughly within view (30 degrees) and within reasonable range
    if (dot > 0.86) { 
      const dist = b.position.distanceTo(_worldPos)
      if (dist < 40) {
        const score = dot * (1.0 - dist / 80)
        if (score > bestScore) {
          bestScore = score
          bestTargetPos = b.position
        }
      }
    }
  }
  if (bestTargetPos) {
    const targetDir = _v2.copy(bestTargetPos).sub(_worldPos).normalize()
    muzzleDir.lerp(targetDir, 0.18).normalize() // Subtle 18% bias toward the target
  }

  const muzzlePos = new THREE.Vector3()
  const anchor = heldWeapons.getMuzzleFlashAnchor()
  if (anchor) {
    anchor.getWorldPosition(muzzlePos)
  } else {
    muzzlePos.copy(_worldPos)
    muzzlePos.addScaledVector(muzzleDir, 0.55)
  }

  // Power scales derived from charge (0 to 1) - reduced speeds for "throw" feel
  const baseSpeed = 0.05
  const maxSpeed = 0.45
  const throwSpeed = baseSpeed + (maxSpeed - baseSpeed) * charge

  // Muzzle Dir is the look direction
  const throwVel = muzzleDir.clone().setLength(throwSpeed)
  
  // Add player velocity inheritance (muted for stability)
  const inheritVel = _tmpKb.copy(player.state.velocity).multiplyScalar(0.4)
  throwVel.add(inheritVel)

  return { muzzlePos, throwVel, scale: cfg.uniformScale }
}

function throwGrenade(charge: number) {
  const params = getGrenadeThrowParams(charge)
  if (!params) return

  const mdl = heldWeapons.getWeaponModel(GRENADE_SLOT)
  if (mdl) {
    grenadeSystem.setModel(mdl)
  }

  grenadeSystem.throw(params.muzzlePos, params.throwVel, params.scale)

  const throwCfg = heldWeapons.currentConfig
  if (throwCfg?.knockback) {
    _tmpKb.copy(muzzleDir).multiplyScalar(-throwCfg.knockback)
    player.applyImpulse(_tmpKb)
  }
}

function updateCrosshairEnemyHover() {
  if (isDead) {
    crosshair.setEnemyHover(false)
    return
  }
  if (!player.controls.isLocked) {
    crosshair.setEnemyHover(false)
    return
  }
  core.camera.getWorldPosition(_worldPos)
  core.camera.getWorldDirection(muzzleDir)
  const targets = targetPlayers.getRaycastTargets()
  const netTargets = multiplayer.getRaycastTargets()
  const h = pickShootIntersection(_worldPos, muzzleDir, mesh, sphereRadius, targets, netTargets, tents.getRaycastTargets(), barriers.getRaycastTargets(), wallSteps.getRaycastTargets(), trees.getRaycastTargets())
  if (!h) {
    crosshair.setEnemyHover(false)
    return
  }
  if (h.object === mesh) {
    crosshair.setEnemyHover(false)
    return
  }
  const ud = h.object.userData as { networkPlayerId?: string; targetIdx?: number }
  if (ud.networkPlayerId || typeof ud.targetIdx === 'number') {
    crosshair.setEnemyHover(true)
  } else {
    crosshair.setEnemyHover(false)
  }
}

let lastHealth = player.state.health
let isFrozen = false
let settingsWasOpenLastFrame = false
let lastDamageTakenAtMs = performance.now()
const PASSIVE_HEAL_DELAY_MS = 3000
const PASSIVE_HEAL_PER_SEC = 4

function resolvePlayerAgainstCollisionBoxes(
  myPos: THREE.Vector3,
  myRadius: number,
  boxes: Array<{ position: THREE.Vector3; halfSize: THREE.Vector3; quaternion: THREE.Quaternion }>
) {
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!
    _boxInvQuat.copy(box.quaternion).invert()
    _boxLocalCenter.copy(myPos).sub(box.position).applyQuaternion(_boxInvQuat)
    _boxClosest.copy(_boxLocalCenter).clamp(
      _v1.copy(box.halfSize).multiplyScalar(-1),
      _v2.copy(box.halfSize)
    )

    _boxLocalNormal.copy(_boxLocalCenter).sub(_boxClosest)
    const distSq = _boxLocalNormal.lengthSq()
    let push = 0
    if (distSq > 1e-8) {
      const dist = Math.sqrt(distSq)
      if (dist >= myRadius) continue
      _boxLocalNormal.multiplyScalar(1 / dist)
      push = myRadius - dist + 1e-4
    } else {
      const dx = box.halfSize.x - Math.abs(_boxLocalCenter.x)
      const dy = box.halfSize.y - Math.abs(_boxLocalCenter.y)
      const dz = box.halfSize.z - Math.abs(_boxLocalCenter.z)
      if (dx <= dy && dx <= dz) {
        _boxLocalNormal.set(_boxLocalCenter.x >= 0 ? 1 : -1, 0, 0)
        push = myRadius + dx + 1e-4
      } else if (dy <= dz) {
        _boxLocalNormal.set(0, _boxLocalCenter.y >= 0 ? 1 : -1, 0)
        push = myRadius + dy + 1e-4
      } else {
        _boxLocalNormal.set(0, 0, _boxLocalCenter.z >= 0 ? 1 : -1)
        push = myRadius + dz + 1e-4
      }
    }

    _boxWorldNormal.copy(_boxLocalNormal).applyQuaternion(box.quaternion).normalize()
    myPos.addScaledVector(_boxWorldNormal, push)
    const into = player.state.velocity.dot(_boxWorldNormal)
    if (into < 0) player.state.velocity.addScaledVector(_boxWorldNormal, -into)
  }
}

function tryAutoLockCursor() {
  if (document.visibilityState !== 'visible') return
  if (document.pointerLockElement === core.renderer.domElement) return
  if (!player.controls.isLocked) {
    void player.controls.lock()
  }
}

const GAME_DEBUG_STORAGE_KEY = 'undersphere_debug'
let gameDebugEnabled = (() => {
  try {
    return localStorage.getItem(GAME_DEBUG_STORAGE_KEY) === '1'
  } catch {
    return false
  }
})()
let playCameraDebugUntilMs = 0
let playCameraDebugLastLogMs = 0
const _debugPrevCamQuat = new THREE.Quaternion()
const _debugPrevPlayerQuat = new THREE.Quaternion()

function setGameDebugEnabled(on: boolean) {
  gameDebugEnabled = on
  try {
    if (on) localStorage.setItem(GAME_DEBUG_STORAGE_KEY, '1')
    else localStorage.removeItem(GAME_DEBUG_STORAGE_KEY)
  } catch {
    /* ignore storage failures */
  }
  console.info(`[game.Debug] ${on ? 'enabled' : 'disabled'}`)
  return `Debug ${on ? 'ON' : 'OFF'}`
}

function pointerLockDebugName(): string {
  const el = document.pointerLockElement
  if (!el) return 'none'
  if (el === core.renderer.domElement) return 'canvas'
  if (el === document.body) return 'body'
  return (el as HTMLElement).tagName?.toLowerCase?.() ?? 'unknown'
}

function cameraDebugSnapshot(label: string, extra?: Record<string, unknown>) {
  if (!gameDebugEnabled) return
  const r = core.camera.rotation
  const cp = core.camera.position
  const pp = player.playerGroup.position
  console.info(`[game.Debug][camera] ${label}`, {
    atMainMenu,
    isPlayTransitioning,
    playTransitionPending: !!playTransitionPending,
    controlsLocked: player.controls.isLocked,
    controlsEnabled: player.controls.enabled,
    pointerLock: pointerLockDebugName(),
    cameraRot: { x: r.x, y: r.y, z: r.z },
    cameraPos: { x: cp.x, y: cp.y, z: cp.z },
    playerPos: { x: pp.x, y: pp.y, z: pp.z },
    playerOnGround: player.state.onGround,
    simulatedUnlocked: input.isSimulatedUnlocked,
    ...extra,
  })
}

function startPlayCameraDebug(reason: string) {
  if (!gameDebugEnabled) return
  playCameraDebugUntilMs = performance.now() + 6000
  playCameraDebugLastLogMs = 0
  _debugPrevCamQuat.copy(core.camera.quaternion)
  _debugPrevPlayerQuat.copy(player.playerGroup.quaternion)
  cameraDebugSnapshot(`play debug start: ${reason}`)
}

function updatePlayCameraDebug(dt: number) {
  if (!gameDebugEnabled || playCameraDebugUntilMs <= 0) return
  const now = performance.now()
  const camDelta = _debugPrevCamQuat.angleTo(core.camera.quaternion)
  const playerDelta = _debugPrevPlayerQuat.angleTo(player.playerGroup.quaternion)
  const shouldLogSpike = camDelta > 0.12 || (!playTransitionPending && playerDelta > 0.12)
  const shouldLogHeartbeat = now - playCameraDebugLastLogMs > 750

  if (shouldLogSpike || shouldLogHeartbeat) {
    playCameraDebugLastLogMs = now
    cameraDebugSnapshot(shouldLogSpike ? 'camera snap candidate' : 'camera play heartbeat', {
      dt,
      camDelta,
      playerDelta,
      debugMsRemaining: Math.max(0, playCameraDebugUntilMs - now),
    })
  }

  _debugPrevCamQuat.copy(core.camera.quaternion)
  _debugPrevPlayerQuat.copy(player.playerGroup.quaternion)

  if (now >= playCameraDebugUntilMs) {
    cameraDebugSnapshot('play debug end')
    playCameraDebugUntilMs = 0
  }
}

function printUndersphereConsoleMessage() {
  console.log(
    '%cUndersphere — Message%c\n\nHey. Thanks for opening the console — and for playing.\n\nEvery player who boots this shell matters; hope the sphere treats you well.\nIf something glitches, a refresh usually snaps things back.\nSee you out there.',
    'font:bold 14px system-ui,-apple-system,sans-serif;color:#e8e8e8;',
    'font:12px system-ui,-apple-system,sans-serif;line-height:1.55;color:#a8a8a8;'
  )
}

window.game = {
  /** Same object as `TRAIN_TRACK_PIECE_ROTATION` — tweak `.x/.y/.z` in **degrees** then `refreshTrainTrack()`. */
  trainTrackRotation: TRAIN_TRACK_PIECE_ROTATION,
  /** Same object as `TRAIN_TRACK_RADIAL_OFFSET` — tweak `.meters` then `refreshTrainTrack()`. */
  trainTrackRadialOffset: TRAIN_TRACK_RADIAL_OFFSET,
  /** Loco + wagons only — tweak `.meters` (no refresh). */
  trainVehicleRadialLift: TRAIN_VEHICLE_RADIAL_LIFT,
  refreshTrainTrack() {
    trainTrack.refreshLayout()
    return 'Train track ring rebuilt'
  },
  inflictDMG(damageAmount: number, dirX?: number, dirY?: number, dirZ?: number) {
    const dir =
      dirX !== undefined && dirY !== undefined && dirZ !== undefined
        ? new THREE.Vector3(dirX, dirY, dirZ).normalize()
        : undefined
    player.inflictDamage(damageAmount, dir)
  },
  testBlood() {
    const p = player.playerGroup.position.clone()
    const up = p.clone().normalize().multiplyScalar(-1)
    const side = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize()
    const direction = up.add(side.multiplyScalar(0.5)).normalize()
    blood.spawn(p, direction, 50)
    return 'Blood explosion triggered!'
  },
  freeze() {
    isFrozen = !isFrozen
    return `Game ${isFrozen ? 'Frozen' : 'Unfrozen'}`
  },
  Debug(on: boolean = true) {
    return setGameDebugEnabled(on)
  },
  muzzleFlash: {
    tuning: muzzleFlashTuning,
    offsetLocal: muzzleFlashOffsetLocal,
    get(slot: number = heldWeapons.getActiveSlot()) {
      const v = heldWeapons.getMuzzleLocal(slot)
      if (!v) return null
      return {
        x: v.x,
        y: v.y,
        z: v.z,
        scale: muzzleFlashTuning.scale,
        flipX: muzzleFlashTuning.flipX,
        offsetLocal: {
          x: muzzleFlashOffsetLocal.x,
          y: muzzleFlashOffsetLocal.y,
          z: muzzleFlashOffsetLocal.z,
        },
      }
    },
    set(slot: number, x: number, y: number, z: number) {
      return heldWeapons.setMuzzleLocal(slot, x, y, z)
        ? `Muzzle slot ${slot} set to (${x}, ${y}, ${z})`
        : `Invalid muzzle slot ${slot}`
    },
    scale(value: number) {
      if (!Number.isFinite(value) || value <= 0) return 'Invalid scale'
      muzzleFlashTuning.scale = value
      syncMuzzleFlashParent()
      return `Muzzle flash scale set to ${value}`
    },
    flip(on: boolean = true) {
      muzzleFlashTuning.flipX = on
      syncMuzzleFlashParent()
      return `Muzzle flash flipX ${on ? 'ON' : 'OFF'}`
    },
    importPayload(json: string) {
      const p = parseMuzzleTuningJson(json)
      if (!p) return 'Invalid muzzle tuning JSON'
      applyMuzzleTuningFromPayload(p)
      return 'Applied muzzle tuning (slots + sprite)'
    },
    exportPayload() {
      const o = exportMuzzleDefaultsPayload()
      o.sprite = {
        scale: muzzleFlashTuning.scale,
        flipX: muzzleFlashTuning.flipX,
        offsetLocal: [muzzleFlashOffsetLocal.x, muzzleFlashOffsetLocal.y, muzzleFlashOffsetLocal.z],
      }
      return JSON.stringify(o, null, 2)
    },
  },
  thirdperson() {
    const on = player.toggleThirdPerson()
    playerModel.setVisible(on)
    heldWeapons.setThirdPerson(on)
    return `Third Person ${on ? 'ON' : 'OFF'}`
  },
  debugTargets(on: boolean) {
    targetPlayers.setDebug(on)
    return `Target debug ${on ? 'ON' : 'OFF'}`
  },
  setBarrierScale(s: number) {
    barriers.updateScales(s)
    return `Barrier scale set to ${s}`
  },
  updateLeaderboard(data: LeaderboardEntry[], myRank?: LeaderboardEntry) {
    leaderboardUI.update(data, myRank)
    return 'Leaderboard updated'
  },
  setUsername(name: string) {
    const u = clampUsername(name)
    if (isProfanityListReady() && textContainsProfanity(u)) {
      return 'That username is not allowed'
    }
    myUsername = u
    persistMyUsernameToLocalStorage()
    mainMenuNameUI?.syncValue(u)
    return `Username set to ${u}`
  },
  fireEndRound() {
    if (atMainMenu) {
      return 'Not in game (main menu)'
    }
    if (matchEndedFreeze && matchEndedByDebug) {
      matchEndedByDebug = false
      matchEndedFreeze = false
      matchEndTopThreeCache = null
      matchEndShowcase.clear()
      matchEndUI.hide()
      if (!isDead) {
        player.setPointerLockAllowed(true)
        player.controls.enabled = player.controls.isLocked
        crosshair.setVisible(true)
      }
      return 'Debug match end cleared'
    }
    pendingDebugMatchEnd = true
    return 'Match end on next frame (call game.fireEndRound() again to clear while held by debug)'
  },
}

printUndersphereConsoleMessage()

let viewToggleKeyWasDown = false
let reloadKeyWasDown = false
let digit1WasDown = false
let digit2WasDown = false
let digit3WasDown = false
let gamepadL1WasDown = false
let gamepadR1WasDown = false
let simFrame = 0
const timer = new THREE.Timer()

/** Low-pass human tally so `pvpOnlyMode` doesn't flip every frame (that respawns/sinks bots = jitter). */
let smoothedHumanCountForBots = 1

function rawHumanCountForBotRules(): number {
  if (settingsUI.soloPlay) return 1
  return multiplayer.getHumanPlayerCount()
}

function updateSmoothedHumanCountForBots(dt: number, snapToRaw: boolean) {
  const raw = rawHumanCountForBotRules()
  if (snapToRaw) {
    smoothedHumanCountForBots = raw
    return
  }
  if (raw >= smoothedHumanCountForBots) {
    smoothedHumanCountForBots = raw
  } else {
    smoothedHumanCountForBots += (raw - smoothedHumanCountForBots) * Math.min(1, dt * 7)
  }
}

function pvpBotsSuppressedFromSmoothedCount(): boolean {
  return smoothedHumanCountForBots >= 1.62
}

function animate() {
  requestAnimationFrame(animate)

  input.update()
  handleMainMenuGamepad()
  if (input.gamepadConnected && !atMainMenu && !isPlayTransitioning) {
    isLeftMouseDownOnGamepad = input.isGamepadButtonPressed(7) // R2 / RT
    isRightMouseDownOnGamepad = input.isGamepadButtonPressed(6) // L2 / LT

    const l1Down = input.isGamepadButtonPressed(4)
    const r1Down = input.isGamepadButtonPressed(5)
    const allowGamepadWeaponSwitch = !settingsUI.isOpen && !isDead && !matchEndedFreeze
    if (allowGamepadWeaponSwitch) {
      if (r1Down && !gamepadR1WasDown) {
        const current = heldWeapons.getActiveSlot()
        const next = (current + 1) % 3
        switchWeaponSlot(next)
      }
      if (l1Down && !gamepadL1WasDown) {
        const current = heldWeapons.getActiveSlot()
        const next = (current + 2) % 3
        switchWeaponSlot(next)
      }
      if (input.isGamepadButtonPressed(12)) {
        switchWeaponSlot(AK_SLOT)
      } else if (input.isGamepadButtonPressed(13)) {
        switchWeaponSlot(GRENADE_SLOT)
      } else if (input.isGamepadButtonPressed(14)) {
        switchWeaponSlot(AK_SLOT)
      } else if (input.isGamepadButtonPressed(15)) {
        switchWeaponSlot(SHOTGUN_SLOT)
      }
    }
    gamepadL1WasDown = l1Down
    gamepadR1WasDown = r1Down
  } else {
    isLeftMouseDownOnGamepad = false
    isRightMouseDownOnGamepad = false
    gamepadL1WasDown = false
    gamepadR1WasDown = false
  }

  const effectiveLeftDown = isLeftMouseDown || isLeftMouseDownOnGamepad || input.isKeyDown('MouseLeft')
  const effectiveRightDown = isRightMouseDown || isRightMouseDownOnGamepad
  const controlsActive = player.controls.isLocked || input.isMobileControlsActive()

  let lastFrameDt = 0
  if (!isFrozen) {
    timer.update()
    let dt = timer.getDelta()
    // Sanity check for dt to prevent animation freezes or skips
    if (isNaN(dt) || dt <= 0) dt = 1/60
    if (dt > 0.1) dt = 0.1 
    if (dt < 0.001) dt = 0.001
    
    lastFrameDt = dt
    const time = performance.now() / 1000
    const currentTime = performance.now()
    simFrame++
    updatePlayCameraDebug(dt)

    updateAudioListener()
    updateHeartbeatByHealth(player.state.health, player.state.maxHealth)

    const mobileLook = input.consumeVirtualLookDelta()
    if (controlsActive && (mobileLook.x !== 0 || mobileLook.y !== 0)) {
      const euler = new THREE.Euler(0, 0, 0, 'YXZ')
      euler.setFromQuaternion(core.camera.quaternion)
      euler.y -= mobileLook.x * 0.0032
      euler.x -= mobileLook.y * 0.0032
      const PI_2 = Math.PI / 2 - 0.01
      euler.x = Math.max(-PI_2, Math.min(PI_2, euler.x))
      core.camera.quaternion.setFromEuler(euler)
    }

    // Gamepad Look (Right Stick)
    if (input.gamepadConnected && controlsActive) {
      const lookX = input.getGamepadAxis(2)
      const lookY = input.getGamepadAxis(3)
      if (Math.abs(lookX) > 0.05 || Math.abs(lookY) > 0.05) {
        const sensitivity = input.lookSensitivity * dt * 50
        const euler = new THREE.Euler(0, 0, 0, 'YXZ')
        euler.setFromQuaternion(core.camera.quaternion)
        euler.y -= lookX * sensitivity * 0.035
        euler.x -= lookY * sensitivity * 0.035
        
        // Clamp pitch to prevent flipping
        const PI_2 = Math.PI / 2 - 0.01
        euler.x = Math.max(-PI_2, Math.min(PI_2, euler.x))
        
        core.camera.quaternion.setFromEuler(euler)
      }
    }

    if (atMainMenu) {
      leaderboardUI.setVisible(false)
      timerUI.setVisible(false)
    }

    if (atMainMenu && !isDead && !isPlayTransitioning) {
      grass.update(time)
      trees.update(time)
      trainTrack.update(dt)
      updateTrainSpatialAudio()
      targetPlayers.syncPlayerSpawnHint(_mainMenuBotHint)
      if (!mainMenuFullChromeApplied) {
        applyMainMenuView()
        mainMenuFullChromeApplied = true
      } else {
        snapMainMenuPose()
      }
      if (!menuAkGunSkinSynced && playerModel.ready && heldWeapons.weaponsLoaded) {
        applyEquippedOwnedAkGunSkin()
        menuAkGunSkinSynced = true
      }
      player.state.isThirdPerson = true
      playerModel.setVisible(true, false)
      playerModel.setOutlineVisible(true)
      playerModel.setCharacterCastShadow(false)
      if (playerModel.root) {
        if (playerModel.root.parent !== menuCharacterHolder) {
          menuCharacterHolder.add(playerModel.root)
        }
        playerModel.root.position.set(0, 0, 0)
        playerModel.root.quaternion.identity()
        playerModel.applyMenuWeaponSlot(AK_SLOT)
      }
      if (playerModel.anims) {
        playerModel.anims.setState('idle', 0.12)
        playerModel.anims.setPitch(0)
      }
      playerModel.update(dt)
      heldWeapons.update(dt, player.state.gravity)

      updateSmoothedHumanCountForBots(dt, true)
      const pvpOnlyMode = pvpBotsSuppressedFromSmoothedCount()
      targetPlayers.setSuppressedByRealPlayers(pvpOnlyMode)

      const botBrain: BotBrainContext | null = !pvpOnlyMode ? {
        playerPosition: player.playerGroup.position,
        playerAlive: true,
        getHumanPositionsForVision: () => {
          const out: THREE.Vector3[] = []
          for (const p of multiplayer.getAllPlayers()) {
            if (!p.ragdoll && p.health > 0 && !p.atMenu) out.push(p.model.position)
          }
          return out
        },
        getObstacleBodies: (excludeBotIndex) => getBotObstacleBodies(excludeBotIndex),
        worldMesh: mesh,
        nowMs: currentTime,
        tryBotAkHit: (..._args: any[]) => { /* noop in menu */ },
      } : null

      targetPlayers.update(dt, botBrain)

      // Sync menu state to multiplayer so others know we are at menu
      multiplayer.update(
        dt,
        player.playerGroup.position,
        player.playerGroup.quaternion,
        0, // localViewYaw
        0, // localViewPitch
        myUsername,
        myBotKills + myPvpKills,
        'idle',
        heldWeapons.getActiveSlot(),
        true, // atMenu
        false // isDead
      )

      const frameEquivMenuNade = dt * 60
      const stepCountMenuNade = Math.max(1, Math.min(Math.floor(frameEquivMenuNade + 1e-9), 24))
      const stepDtMenuNade = 1 / 60
      for (let s = 0; s < stepCountMenuNade; s++) {
        grenadeSystem.update(stepDtMenuNade, player.state.gravity)
      }
      if (heldWeapons.getWeaponModel(GRENADE_SLOT)) {
        grenadeSystem.setModel(heldWeapons.getWeaponModel(GRENADE_SLOT)!)
      }

      settingsUI.setTopRightButtonSuppressed(true)
      settingsUI.update(input, false)
      fpsCounter.update()

      const menuTargetFov = 50 + settingsUI.fovPercent * 70
      if (currentFov !== menuTargetFov) {
        currentFov = menuTargetFov
        core.camera.fov = currentFov
        core.camera.updateProjectionMatrix()
      }

      core.render()
      return
    }

    if (playTransitionPending) {
      advancePlayTransition()
      grass.update(time)
      trees.update(time)
      if (trainPhaseSynced) {
        const speed = 1.0
        const elapsed = (Date.now() - localSyncTimeForTrain) / 1000
        const currentPhase = initialTrainPhaseForTrain - elapsed * speed
        trainTrack.update(dt, currentPhase)
      } else {
        trainTrack.update(dt)
      }
      updateTrainSpatialAudio()
      multiplayer.update(
        dt,
        player.playerGroup.position,
        player.playerGroup.quaternion,
        0,
        0,
        myUsername,
        myBotKills + myPvpKills,
        'idle',
        heldWeapons.getActiveSlot(),
        true,
        false
      )
      settingsUI.setTopRightButtonSuppressed(true)
      settingsUI.update(input, false)
      fpsCounter.update()
      core.render()
      matchEndShowcase.update(lastFrameDt, matchEndedFreeze && !atMainMenu && !isFrozen)
      return
    }

    settingsUI.setTopRightButtonSuppressed(false)
    grass.update(time)
    trees.update(time)
    
    // Smoothly update train phase based on synchronized match time
    if (trainPhaseSynced) {
      const speed = 1.0 // TRAIN_VEHICLE_SPEED
      const elapsed = (Date.now() - localSyncTimeForTrain) / 1000
      // We know at localSyncTimeForTrain, the phase was initialTrainPhaseForTrain
      const currentPhase = initialTrainPhaseForTrain - (elapsed * speed)
      trainTrack.update(dt, currentPhase)
    } else {
      trainTrack.update(dt)
    }

    updateTrainSpatialAudio()
    targetPlayers.syncPlayerSpawnHint(player.playerGroup.position)

    updateSmoothedHumanCountForBots(dt, false)
    const pvpOnlyMode = pvpBotsSuppressedFromSmoothedCount()
    targetPlayers.setSuppressedByRealPlayers(pvpOnlyMode)
    timerUI.setCountdownActive(pvpOnlyMode)
    timerUI.update()

    if (!atMainMenu) {
      if (pendingDebugMatchEnd) {
        pendingDebugMatchEnd = false
        matchEndedByDebug = true
      }
      const naturalEnd = pvpOnlyMode && timerUI.hasCountdownExpired()
      const shouldHoldMatchEnd = naturalEnd || matchEndedByDebug
      if (shouldHoldMatchEnd) {
        if (!matchEndedFreeze) {
          if (naturalEnd) {
            matchEndedByDebug = false
          }
          matchEndedFreeze = true
          player.setPointerLockAllowed(false)
          try {
            player.controls.unlock()
          } catch {
            /* noop */
          }
          player.controls.enabled = false
          player.state.isAiming = false
          heldWeapons.setAiming(false)
          crosshair.setVisible(false)
          leaderboardUI.setOpacity(0)
          timerUI.setOpacity(0)
          healthUI.setOpacity(0)
          ammoUI.setOpacity(0)
          weaponUI.setOpacity(0)
          killFeed.setOpacity(0)
          coinsHUD.setOpacity(0)
          staminaUI.setOpacity(0)
          const entries = buildSortedLeaderboardEntries()
          matchEndTopThreeCache = entries.slice(0, 3)

          const myIx = matchEndTopThreeCache.findIndex(e => e.id === 'me' || e.username === myUsername)
          if (myIx === 0) setCoins(getCoins() + 500)
          else if (myIx === 1) setCoins(getCoins() + 300)
          else if (myIx === 2) setCoins(getCoins() + 100)

          matchEndUI.show(matchEndTopThreeCache)
          matchEndShowcase.syncFromEntries(matchEndTopThreeCache)

          // Auto-reset back to lobby after 5 seconds
          if (matchEndTimeout) clearTimeout(matchEndTimeout)
          matchEndTimeout = setTimeout(() => {
            returnToMainMenu()
          }, 5000)
        }
      } else if (matchEndedFreeze) {
        matchEndedFreeze = false
        matchEndedByDebug = false
        matchEndTopThreeCache = null
        matchEndShowcase.clear()
        matchEndUI.hide()
        if (!isDead) {
          player.setPointerLockAllowed(true)
          player.controls.enabled = player.controls.isLocked
          crosshair.setVisible(true)
          leaderboardUI.setOpacity(1)
          timerUI.setOpacity(1)
          healthUI.setOpacity(1)
          ammoUI.setOpacity(1)
          weaponUI.setOpacity(1)
          killFeed.setOpacity(1)
          coinsHUD.setOpacity(1)
          staminaUI.setOpacity(1)
        }
      }
    }

    if (!isDead && !matchEndedFreeze) {
      if (settingsUI.isOpen) input.isSimulatedUnlocked = true
      const activeSlot = heldWeapons.getActiveSlot()
      const isGrenade = activeSlot === GRENADE_SLOT

      const canAim = controlsActive && effectiveRightDown && !isGrenade
      player.state.isAiming = canAim
      heldWeapons.setAiming(canAim)

      // GRENADE CHARGE ON LEFT CLICK
      if (isGrenade && controlsActive) {
        const hasAmmo = ammoSystem.canSpend(activeSlot)
        if (effectiveLeftDown && hasAmmo) {
          grenadeCharge = Math.min(1.0, grenadeCharge + dt * 1.5)
          player.state.shakeIntensity = Math.max(player.state.shakeIntensity, grenadeCharge * 0.12)
        } else if (wasLeftMouseDownLastFrame) {
          if (grenadeCharge > 0.01) {
            if (heldWeapons.canFire(currentTime) && ammoSystem.canSpend(activeSlot)) {
              throwGrenade(grenadeCharge)
              heldWeapons.triggerFire(currentTime)
              ammoSystem.tryConsume(activeSlot)
              heldWeapons.setModelVisibility(activeSlot, false)
              grenadeCharge = 0
            } else {
              // Not ready or no ammo, keep charge or just reset if no ammo
              if (!hasAmmo) grenadeCharge = 0
            }
          } else {
            grenadeCharge = 0
          }
        } else {
          grenadeCharge = 0
        }
      }

      player.update(input, sphereRadius, core.camera)
    } else if (isDead && !matchEndedFreeze) {
      player.state.isAiming = false
      heldWeapons.setAiming(false)
      player.state.isThirdPerson = true
      player.controls.enabled = false

      const netKiller = deadKillerId ? multiplayer.getPlayerById(deadKillerId) : null
      const botKiller = deadKillerId ? targetPlayers.getTargetById(deadKillerId) : null
      const killerModel = netKiller ? netKiller.model : botKiller?.container

      if (killerModel) {
        // Track the killer in real-time using world coordinates
        const killerPos = new THREE.Vector3()
        const killerQuat = new THREE.Quaternion()
        killerModel.getWorldPosition(killerPos)
        killerModel.getWorldQuaternion(killerQuat)

        // Inner sphere: "up" points toward center (same as PlayerController upDir = -radial outward)
        const gravityUp = killerPos.lengthSq() < 1e-8 ? new THREE.Vector3(0, 1, 0) : killerPos.clone().normalize().multiplyScalar(-1)

        // Snap playerGroup to killer's position so our relative camera math works
        player.playerGroup.position.copy(killerPos)
        player.playerGroup.quaternion.copy(killerQuat)

        const currentUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.playerGroup.quaternion)
        const gravityAlignQuat = new THREE.Quaternion().setFromUnitVectors(currentUp, gravityUp)
        player.playerGroup.quaternion.premultiply(gravityAlignQuat)

        core.camera.up.copy(gravityUp)

        const targetCamPos = new THREE.Vector3(0, 2.0, 5.5)
        core.camera.position.lerp(targetCamPos, 0.15)

        const lookTarget = killerPos.clone().add(gravityUp.clone().multiplyScalar(1.4))
        core.camera.lookAt(lookTarget)
      } else {
        // Killer not found (could be self, disconnected player, or bot)
        player.state.isThirdPerson = true
        const bodyPos = player.playerGroup.position
        const gravityUp =
          bodyPos.lengthSq() < 1e-8 ? new THREE.Vector3(0, 1, 0) : bodyPos.clone().normalize().multiplyScalar(-1)
        core.camera.up.copy(gravityUp)
        core.camera.position.lerp(new THREE.Vector3(0, 2.0, 5.5), 0.1)
        const lookTarget = bodyPos.clone().add(gravityUp.clone().multiplyScalar(1.2))
        core.camera.lookAt(lookTarget)
      }
    } else if (matchEndedFreeze) {
      player.state.isAiming = false
      heldWeapons.setAiming(false)
      player.controls.enabled = false
      if (isDead) {
        player.state.isThirdPerson = true
      }
    }
    if (!isDead && !matchEndedFreeze) {
      // Prevent phasing through target players (simple sphere-vs-sphere resolution).
      const myPos = player.playerGroup.position
      const myRadius = Math.max(0.55, player.state.currentHeight * 0.34)
      const bodies = targetPlayers.getCollisionBodies()
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i]!
        _colDelta.copy(myPos).sub(b.position)
        const distSq = _colDelta.lengthSq()
        if (distSq < 1e-8) continue
        const minDist = myRadius + b.radius
        if (distSq >= minDist * minDist) continue
        const dist = Math.sqrt(distSq)
        const push = minDist - dist + 1e-4
        _colDelta.multiplyScalar(1 / dist)
        myPos.addScaledVector(_colDelta, push)
        const into = player.state.velocity.dot(_colDelta)
        if (into < 0) {
          player.state.velocity.addScaledVector(_colDelta, -into)
        }
      }

      // Prevent phasing through networked players (same sphere-vs-sphere resolution).
      const netBodies = multiplayer.getCollisionBodies()
      for (let i = 0; i < netBodies.length; i++) {
        const b = netBodies[i]!
        _colDelta.copy(myPos).sub(b.position)
        const distSq = _colDelta.lengthSq()
        if (distSq < 1e-8) continue
        const minDist = myRadius + b.radius
        if (distSq >= minDist * minDist) continue
        const dist = Math.sqrt(distSq)
        const push = minDist - dist + 1e-4
        _colDelta.multiplyScalar(1 / dist)
        myPos.addScaledVector(_colDelta, push)
        const into = player.state.velocity.dot(_colDelta)
        if (into < 0) {
          player.state.velocity.addScaledVector(_colDelta, -into)
        }
      }

      // Prevent phasing through tents
      const tentBodies: Array<{ position: THREE.Vector3; radius: number }> = []
      for (let i = 0; i < tentBodies.length; i++) {
        const b = tentBodies[i]!
        _colDelta.copy(myPos).sub(b.position)
        const distSq = _colDelta.lengthSq()
        if (distSq < 1e-8) continue
        const minDist = myRadius + b.radius
        if (distSq >= minDist * minDist) continue
        const dist = Math.sqrt(distSq)
        const push = minDist - dist + 1e-4
        _colDelta.multiplyScalar(1 / dist)
        myPos.addScaledVector(_colDelta, push)
        const into = player.state.velocity.dot(_colDelta)
        if (into < 0) {
          player.state.velocity.addScaledVector(_colDelta, -into)
        }
      }

      // Prevent phasing through barriers
      const barrierBodies: Array<{ position: THREE.Vector3; radius: number }> = []
      for (let i = 0; i < barrierBodies.length; i++) {
        const b = barrierBodies[i]!
        _colDelta.copy(myPos).sub(b.position)
        const distSq = _colDelta.lengthSq()
        if (distSq < 1e-8) continue
        const minDist = myRadius + b.radius
        if (distSq >= minDist * minDist) continue
        const dist = Math.sqrt(distSq)
        const push = minDist - dist + 1e-4
        _colDelta.multiplyScalar(1 / dist)
        myPos.addScaledVector(_colDelta, push)
        const into = player.state.velocity.dot(_colDelta)
        if (into < 0) {
          player.state.velocity.addScaledVector(_colDelta, -into)
        }
      }

      // Prevent phasing through wall steps
      const wallStepBodies: Array<{ position: THREE.Vector3; radius: number }> = []
      for (let i = 0; i < wallStepBodies.length; i++) {
        const b = wallStepBodies[i]!
        _colDelta.copy(myPos).sub(b.position)
        const distSq = _colDelta.lengthSq()
        if (distSq < 1e-8) continue
        const minDist = myRadius + b.radius
        if (distSq >= minDist * minDist) continue
        const dist = Math.sqrt(distSq)
        const push = minDist - dist + 1e-4
        _colDelta.multiplyScalar(1 / dist)
        myPos.addScaledVector(_colDelta, push)
        const into = player.state.velocity.dot(_colDelta)
        if (into < 0) {
          player.state.velocity.addScaledVector(_colDelta, -into)
        }
      }

      // Prevent phasing through trees
      const treeBodies = trees.getCollisionBodies()
      for (let i = 0; i < treeBodies.length; i++) {
        const b = treeBodies[i]!
        _colDelta.copy(myPos).sub(b.position)
        const distSq = _colDelta.lengthSq()
        if (distSq < 1e-8) continue
        const minDist = myRadius + b.radius
        if (distSq >= minDist * minDist) continue
        const dist = Math.sqrt(distSq)
        const push = minDist - dist + 1e-4
        _colDelta.multiplyScalar(1 / dist)
        myPos.addScaledVector(_colDelta, push)
        const into = player.state.velocity.dot(_colDelta)
        if (into < 0) {
          player.state.velocity.addScaledVector(_colDelta, -into)
        }
      }

      resolvePlayerAgainstCollisionBoxes(myPos, myRadius, tents.getCollisionBoxes())
      resolvePlayerAgainstCollisionBoxes(myPos, myRadius, barriers.getCollisionBoxes())
      resolvePlayerAgainstCollisionBoxes(myPos, myRadius, wallSteps.getCollisionBoxes())
      resolvePlayerAgainstCollisionBoxes(myPos, myRadius, trees.getCollisionBoxes())

      const isProtected = localSpawnDamageInvulnerable()
      if (!atMainMenu && !isProtected) {
        const nowTrainHit = performance.now()
        if (nowTrainHit - lastTrainPlayerHitMs >= TRAIN_PLAYER_HIT_COOLDOWN_MS) {
          if (trainTrack.testPlayerTrainCollision(myPos, myRadius, _trainHitAway)) {
            lastTrainPlayerHitMs = nowTrainHit
            _trainHitAway.normalize()
            player.inflictDamage(TRAIN_PLAYER_HIT_DAMAGE, _trainHitAway)
            playSfx('impact', 1.0, 'impact', true)
            if (player.state.health <= 0) {
              handleLocalDeathFromTrain(_trainHitAway)
            } else {
            player.applyImpulse(_tmpKb.copy(_trainHitAway).multiplyScalar(TRAIN_PLAYER_HIT_KNOCKBACK))
          }
        }
      }

      // Train vs Bots collision
      const botCount = targetPlayers.getTargetList().length
      for (let i = 0; i < botCount; i++) {
        const bot = targetPlayers.getTargetById(`bot_${i}`)
        if (!bot || bot.despawnedForPvP || bot.ragdoll || bot.health <= 0) continue
        
        const now = performance.now()
        if (now - lastTrainBotHitMs[i]! >= TRAIN_PLAYER_HIT_COOLDOWN_MS) {
          const botPos = bot.container.position
          const botRadius = 0.65
          if (trainTrack.testPlayerTrainCollision(botPos, botRadius, _trainHitAway)) {
            lastTrainBotHitMs[i] = now
            _trainHitAway.normalize()
            targetPlayers.inflictDirectDamage(i, TRAIN_PLAYER_HIT_DAMAGE, _tmpKb.copy(_trainHitAway).multiplyScalar(TRAIN_PLAYER_HIT_KNOCKBACK))
            playSfx('impact', 1.0, 'impact', true)
          }
        }
      }
    }
    }
    if (player.state.onGround) shotgunMidairKnockbackUsed = false

    if (isReloading && performance.now() > reloadStartedAt + RELOAD_MS) {
      if (ammoSystem.reload(reloadSlot)) {
        // If we reloaded a consumable like a grenade, make it visible again
        heldWeapons.setModelVisibility(reloadSlot, true)
      }
      isReloading = false
      reloadSlot = -1
      reloadStartedAt = 0
    }
    blood.update(core.camera)
    bulletHoles.update(core.camera)

    const botBrain: BotBrainContext | null = !settingsUI.isOpen && !matchEndedFreeze
      ? {
        playerPosition: player.playerGroup.position,
        playerAlive: !isDead,
        getHumanPositionsForVision: () => {
          const out: THREE.Vector3[] = []
          const grace = localSpawnDamageInvulnerable()
          if (!isDead && !grace) out.push(player.playerGroup.position)
          for (const p of multiplayer.getAllPlayers()) {
            if (!p.ragdoll && p.health > 0 && !p.atMenu) out.push(p.model.position)
          }
          return out
        },
        getObstacleBodies: (excludeBotIndex) => getBotObstacleBodies(excludeBotIndex),
        worldMesh: mesh,
        nowMs: currentTime,
        tryBotAkHit,
      }
      : null
    targetPlayers.update(dt, botBrain)

    // REVERTED TO FIXED TIMESTEP LOOP: This is much more reliable for physics/ground hits
    const frameEquivNade = dt * 60
    const stepCountNade = Math.max(1, Math.min(Math.floor(frameEquivNade + 1e-9), 120))
    const stepDtNade = 1 / 60
    for (let s = 0; s < stepCountNade; s++) {
      grenadeSystem.update(stepDtNade, player.state.gravity)
    }

    // Ensure grenade system has our model once it's loaded
    if (heldWeapons.getWeaponModel(GRENADE_SLOT)) {
      grenadeSystem.setModel(heldWeapons.getWeaponModel(GRENADE_SLOT)!)
    }
    damageTexts.update(dt, core.camera)

    if (!isDead && effectiveLeftDown && controlsActive) {
      const activeSlotForShooting = heldWeapons.getActiveSlot()
      const cfg = heldWeapons.currentConfig
      if (cfg && activeSlotForShooting !== GRENADE_SLOT) {
        if (cfg.isAutomatic || !wasLeftMouseDownLastFrame) {
          shoot()
        }
      }
    }
    wasLeftMouseDownLastFrame = effectiveLeftDown

    const vDown = input.isKeyDown('KeyV')
    if (!isDead && !matchEndedFreeze && vDown && !viewToggleKeyWasDown) {
      player.toggleThirdPerson()
      heldWeapons.setThirdPerson(player.state.isThirdPerson)
    }
    viewToggleKeyWasDown = vDown

    if (!isDead) {
      playerModel.setVisible(player.state.isThirdPerson)
      playerModel.syncToPlayer(
        player.playerGroup.position,
        player.playerGroup.quaternion,
        core.camera.quaternion,
        sphereRadius,
        player.state.currentHeight * 0.5,
        player.state.onGround,
        heldWeapons.getActiveSlot()
      )
    }

    // Handle Local Player Animations
    let currentAnim: AnimationState = 'idle'
    const isMovingLocal = input.isKeyDown('KeyW') || input.isKeyDown('KeyS') || input.isKeyDown('KeyA') || input.isKeyDown('KeyD')

    if (!player.state.onGround) {
      currentAnim = 'jump'

      // Predict landing for animation trigger
      const distToGround = (sphereRadius - player.state.currentHeight / 2) - player.playerGroup.position.length()
      const verticalVel = player.state.velocity.dot(player.playerGroup.position.clone().normalize())

      // If moving towards ground and close (adjust threshold as needed)
      if (verticalVel > 0.05 && distToGround < 1.5) {
        if (playerModel.anims) playerModel.anims.setJumpLandingTrigger()
      }
    } else if (player.state.isCrouching) {
      currentAnim = isMovingLocal ? 'crouch_walk' : 'crouch_idle'
    } else if (isMovingLocal) {
      currentAnim = player.state.isSprinting ? 'sprint' : 'walk'
    } else {
      currentAnim = 'idle'
    }

    if (matchEndedFreeze && !isDead) {
      currentAnim = 'idle'
    }

    // Calculate local pitch/yaw for animations and multiplayer.
    // Since camera is a child of playerGroup, camera.rotation is already local to the player's orientation.
    const localViewPitch = core.camera.rotation.x
    const localViewYaw = core.camera.rotation.y

    if (!isDead) {
      if (playerModel.anims) {
        playerModel.anims.setState(currentAnim)
        playerModel.anims.setPitch(localViewPitch)
      }
      playerModel.update(dt)
    } else {
      if (localPlayerRagdoll) {
        localPlayerRagdoll.update(dt, sphereRadius)
      }
    }

    if (!isDead) {
      heldWeapons.update(dt, player.state.gravity)
    }
    syncMuzzleFlashParent()

    // Remotes only run triggerFire() when anim === 'firing'; local uses triggerFire from shoot() instead.
    const ANIM_FIRE_NET_MS = 340
    let animForNet: AnimationState = currentAnim
    if (
      !isDead &&
      !matchEndedFreeze &&
      heldWeapons.getActiveSlot() !== GRENADE_SLOT &&
      performance.now() - heldWeapons.lastFireTime < ANIM_FIRE_NET_MS
    ) {
      animForNet = 'firing'
    }
    const finalActiveSlot = heldWeapons.getActiveSlot()
    tickMultiplayerAfkDisconnect(input, {
      connected: multiplayer.isConnected(),
      soloPlay: settingsUI.soloPlay,
      atMenu: atMainMenu,
      dead: isDead,
      matchFrozen: matchEndedFreeze,
      effectiveLeftDown,
      effectiveRightDown,
    })
    multiplayer.update(
      dt,
      player.playerGroup.position,
      player.playerGroup.quaternion,
      localViewYaw,
      localViewPitch,
      myUsername,
      myBotKills + myPvpKills,
      isDead ? 'idle' : animForNet,
      finalActiveSlot,
      atMainMenu,
      isDead
    )

    if ((simFrame & 1) === 0) {
      updateCrosshairEnemyHover()
    }

    if (muzzleFlashLife > 0) {
      muzzleFlashLife -= dt
      if (muzzleFlashLife <= 0) {
        muzzleFlash.visible = false
      }
    }

    settingsUI.update(input, isDead || matchEndedFreeze)
    if (settingsWasOpenLastFrame && !settingsUI.isOpen) {
      input.isSimulatedUnlocked = false
      if (!atMainMenu && !isDead && !matchEndedFreeze) {
        player.setPointerLockAllowed(true)
        input.centerVirtualMouse()
        tryAutoLockCursor()
      }
    }
    settingsWasOpenLastFrame = settingsUI.isOpen
    fpsCounter.update()
    {
      const slot = heldWeapons.getActiveSlot()
      const st = slot < 3 ? ammoSystem.getState(slot) : null
      const progress = isReloading
        ? Math.min((performance.now() - reloadStartedAt) / RELOAD_MS, RELOAD_FINISH_PROGRESS)
        : 0
      const isActiveReload = isReloading && reloadSlot === slot
      ammoUI.update(
        st?.mag ?? 0,
        st?.maxMag ?? 0,
        slot < 3 && st !== null,
        isActiveReload,
        progress
      )
    }
    healthUI.update(player.state.health, player.state.maxHealth)
    updateHeartbeatByHealth(player.state.health, player.state.maxHealth)

    if (player.state.health < lastHealth) {
      damageIndicator.trigger()
      lastDamageTakenAtMs = currentTime
      lastHealth = player.state.health
    } else if (player.state.health > lastHealth) {
      lastHealth = player.state.health
    }

    if (
      !atMainMenu &&
      !isDead &&
      !matchEndedFreeze &&
      player.state.health > 0 &&
      player.state.health < player.state.maxHealth &&
      currentTime - lastDamageTakenAtMs >= PASSIVE_HEAL_DELAY_MS
    ) {
      player.state.health = Math.min(player.state.maxHealth, player.state.health + PASSIVE_HEAL_PER_SEC * dt)
      lastHealth = player.state.health
    }

    damageIndicator.setLowHealth(player.state.health <= 20)

    const weaponBarHoverBlocksCycle =
      !atMainMenu &&
      !isDead &&
      !matchEndedFreeze &&
      (!document.pointerLockElement || settingsUI.isOpen || input.isSimulatedUnlocked)

    weaponUI.syncPointerHover(input.virtualMousePos.x, input.virtualMousePos.y, weaponBarHoverBlocksCycle)

    const blockWeaponSwitchOverHotbar = weaponUI.isPointerOverWeaponBar()
    const blockWeaponBindFromMenus = settingsUI.isOpen || blockWeaponSwitchOverHotbar

    const wheelDelta = input.consumeWheelDelta()
    if (!isDead && !matchEndedFreeze && !blockWeaponBindFromMenus && Math.abs(wheelDelta) > 0) {
      const current = heldWeapons.getActiveSlot()
      const direction = wheelDelta > 0 ? 1 : -1
      let next = (current + direction) % 3
      if (next < 0) next = 2
      switchWeaponSlot(next)
    }

    const digit1Down = input.isKeyDown('Digit1')
    const digit2Down = input.isKeyDown('Digit2')
    const digit3Down = input.isKeyDown('Digit3')
    if (!isDead && !matchEndedFreeze && !blockWeaponBindFromMenus && digit1Down && !digit1WasDown) switchWeaponSlot(AK_SLOT)
    if (!isDead && !matchEndedFreeze && !blockWeaponBindFromMenus && digit2Down && !digit2WasDown) switchWeaponSlot(SHOTGUN_SLOT)
    if (!isDead && !matchEndedFreeze && !blockWeaponBindFromMenus && digit3Down && !digit3WasDown) switchWeaponSlot(GRENADE_SLOT)
    digit1WasDown = digit1Down
    digit2WasDown = digit2Down
    digit3WasDown = digit3Down

    const reloadDown = input.isKeyDown('KeyR')
    if (!isDead && !matchEndedFreeze && reloadDown && !reloadKeyWasDown && controlsActive && !isReloading) {
      const s = heldWeapons.getActiveSlot()
      if (s < 3 && ammoSystem.canReload(s)) {
        isReloading = true
        reloadSlot = s
        reloadStartedAt = performance.now()
      }
      if (s < 3 && s !== GRENADE_SLOT && isReloading) {
        playSfx('reload', 1.0, 'ui', true)
        multiplayer.sendSound('reload', player.playerGroup.position, 1)
      }
    }
    reloadKeyWasDown = reloadDown

    const isTryingToSprint =
      input.isKeyDown('ShiftLeft') &&
      (input.isKeyDown('KeyW') ||
        input.isKeyDown('KeyS') ||
        input.isKeyDown('KeyA') ||
        input.isKeyDown('KeyD'))
    staminaUI.update(
      player.state.stamina,
      player.state.maxStamina,
      player.state.isSprinting,
      isTryingToSprint,
      currentTime,
      player.state.lastFailedActionTime
    )

    // Update camera FOV from settings with ADS zoom + speed effects (smooth interpolation)
    const baseFov = 50 + settingsUI.fovPercent * 70
    let targetFov = baseFov
    
    if (player.state.isAiming) {
      targetFov = baseFov * 0.82
    } else {
      // Dynamic FOV based on movement state
      if (player.state.isSprinting) targetFov *= 1.15
      if (player.state.isSliding) targetFov *= 1.25
      if (!player.state.onGround && player.state.velocity.length() > player.state.moveSpeed * 2) targetFov *= 1.1
    }

    if (Math.abs(currentFov - targetFov) > 0.05) {
      const blend = 1 - Math.pow(0.005, dt) // Responsive smoothing
      currentFov += (targetFov - currentFov) * blend
      core.camera.fov = currentFov
      core.camera.updateProjectionMatrix()
    } else if (currentFov !== targetFov) {
      currentFov = targetFov
      core.camera.fov = currentFov
      core.camera.updateProjectionMatrix()
    }
  } else {
    settingsUI.update(input, isDead)
    settingsWasOpenLastFrame = settingsUI.isOpen
    fpsCounter.update()
    const slot = heldWeapons.getActiveSlot()
    const st = slot < 3 ? ammoSystem.getState(slot) : null
    const progress = isReloading
      ? Math.min((performance.now() - reloadStartedAt) / RELOAD_MS, RELOAD_FINISH_PROGRESS)
      : 0
    const isActiveReload = isReloading && reloadSlot === slot
    ammoUI.update(
      st?.mag ?? 0,
      st?.maxMag ?? 0,
      slot < 3 && st !== null,
      isActiveReload,
      progress
    )
  }


  core.render()
  matchEndShowcase.update(lastFrameDt, matchEndedFreeze && !atMainMenu && !isFrozen)
}

animate()
