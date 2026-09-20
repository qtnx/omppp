import type { EvalTask } from "./tasks";

// Ground truth inspected in read-only checkouts on 2026-09-19.
// Backend HEAD: 66f9f5d79930a3a66076a38483e9376b06ebca18
// Frontend HEAD: 56332221e629184086478f1c4069cd66f259680c
// Runner verifies declaration anchors before inference and records file hashes.
// Freeze these expectations before measuring; a model miss is not a reason to edit them.

export const BACKEND_TASKS: EvalTask[] = [
	{
		id: "be-troop-file",
		title: "Troop constructor, exact file",
		path: "src/internal/modules/worldmap/combat/troop.go",
		query: "Where is a named troop constructed with its combat stats, movement speed, training time, upkeep and requirements?",
		expect: { file: "src/internal/modules/worldmap/combat/troop.go", contains: "func NewTroop(", startLine: 25 },
		notes: "Go free function; baseline without file navigation.",
	},
	{
		id: "be-troop-directory",
		title: "Troop constructor, combat directory",
		path: "src/internal/modules/worldmap/combat",
		query: "Where is a named troop constructed with its combat stats, movement speed, training time, upkeep and requirements?",
		expect: { file: "src/internal/modules/worldmap/combat/troop.go", contains: "func NewTroop(", startLine: 25 },
		notes: "Same target with sibling combat modules competing for navigation.",
	},
	{
		id: "be-combat-fallback",
		title: "Legacy battle error fallback",
		path: "src/internal/modules/worldmap/combat/combat_utils.go",
		query: "Which entry function resolves attacker and defender legacy army squads, logs resolution errors, and returns an empty legacy-shaped battle result on failure?",
		expect: { file: "src/internal/modules/worldmap/combat/combat_utils.go", contains: "func Combat(", startLine: 44 },
		notes: "Error-path semantics; must return declaration, not nearby comment or delegated resolver.",
	},
	{
		id: "be-march-file",
		title: "Nonempty marching groups, long file",
		path: "src/internal/core/common_dto/travel_dto.go",
		query: "Where does the code scan nested marching army groups and return true if any non-nil troop entry has a positive amount?",
		expect: {
			file: "src/internal/core/common_dto/travel_dto.go",
			contains: "func HasMarchingMilitaries(",
			startLine: 204,
		},
		notes: "Nested loops; target past line 200 in a 1,145-line Go file.",
	},
	{
		id: "be-march-wide",
		title: "Nonempty marching groups, broad core scope",
		path: "src/internal/core",
		query: "Where does the code scan nested marching army groups and return true if any non-nil troop entry has a positive amount?",
		expect: {
			file: "src/internal/core/common_dto/travel_dto.go",
			contains: "func HasMarchingMilitaries(",
			startLine: 204,
		},
		notes: "Multi-level discovery with the default three-file budget; no target path given.",
	},
	{
		id: "be-consumption-tail",
		title: "Consumption reduction deep in long file",
		path: "src/internal/core/common_modules/military/military_usecase.go",
		query: "Where is a fractional percentage reduction applied to resource consumption, with zero for non-positive amounts or a reduction of at least one, and no change for non-positive reductions?",
		expect: {
			file: "src/internal/core/common_modules/military/military_usecase.go",
			contains: "func applyResourceConsumptionReduction(",
			startLine: 1275,
		},
		notes: "Adversarial outline budget case: target at line 1,275 of a 1,754-line file.",
	},
	{
		id: "be-consumption-directory",
		title: "Consumption reduction via military directory",
		path: "src/internal/core/common_modules/military",
		query: "Where is a fractional percentage reduction applied to resource consumption, with zero for non-positive amounts or a reduction of at least one, and no change for non-positive reductions?",
		expect: {
			file: "src/internal/core/common_modules/military/military_usecase.go",
			contains: "func applyResourceConsumptionReduction(",
			startLine: 1275,
		},
		notes: "Navigation plus long-file outline limits; expected miss remains a miss.",
	},
	{
		id: "be-building-value",
		title: "Building attribute calculation, Go receiver",
		path: "src/internal/core/common_dto/building_data_dto.go",
		query: "Where is a building attribute calculated by adding the flat bonus to the base value and then applying the percentage bonus?",
		expect: {
			file: "src/internal/core/common_dto/building_data_dto.go",
			contains: "func (b *BuildingAttributeDataDto) GetTotalValue()",
			startLine: 53,
		},
		notes: "Very short receiver method rather than free function.",
	},
	{
		id: "be-item-grant-rpc",
		title: "Idempotent inventory RPC",
		path: "src/internal/core/common_modules/discovery_client/rpc_ports/economy_rpc_ports.go",
		query: "Which wrapper grants inventory items through the economy RPC with an idempotency key and returns whether the grant succeeded or was replayed?",
		expect: {
			file: "src/internal/core/common_modules/discovery_client/rpc_ports/economy_rpc_ports.go",
			contains: "func (e *economy_rpc_ports) IncreaseItemIdempotent(",
			startLine: 334,
		},
		notes: "Receiver method in a long module with similar grant/decrease wrappers; source retrieval only, no RPC execution.",
	},
	{
		id: "be-guild-points",
		title: "Weekly guild points membership guard",
		path: "src/internal/core/common_modules/guild/guild_service.go",
		query: "Which weekly guild points handler skips zero-point updates, loads the player, skips players without a guild, and triggers the guild airdrop points update?",
		expect: {
			file: "src/internal/core/common_modules/guild/guild_service.go",
			contains: "func (g *GuildService) UpdateWeekPointsForUserGuild(",
			startLine: 180,
		},
		notes: "Go service receiver with error and early-return branches, not the subsequent multiplier implementation.",
	},
	{
		id: "be-negative-near",
		title: "Related but absent behavior",
		path: "src/internal/core/common_dto/building_data_dto.go",
		query: "Which function sends troops on a march and deducts the march's resource cost?",
		expect: null,
		notes: "Plausible game vocabulary, but this narrow scope contains building DTOs, not marching side effects.",
	},
	{
		id: "be-negative-far",
		title: "Unrelated absent behavior",
		path: "src/internal/modules/worldmap/combat/troop.go",
		query: "Where are interplanetary spacecraft trajectories integrated from gravitational acceleration?",
		expect: null,
		notes: "Negative control; no source selection is allowed.",
	},
];

export const FRONTEND_TASKS: EvalTask[] = [
	{
		id: "fe-resource-file",
		title: "Resource coordinates, exact file",
		path: "src/components/map/modal/modalResourceInfoLocation.ts",
		query: "Where are resource coordinates resolved by checking each source's nested location coordinates first, then falling back to its position?",
		expect: {
			file: "src/components/map/modal/modalResourceInfoLocation.ts",
			contains: "export const resolveResourceLocation =",
			startLine: 29,
		},
		notes: "TypeScript arrow function with nested fallback branches.",
	},
	{
		id: "fe-resource-directory",
		title: "Resource coordinates, modal directory",
		path: "src/components/map/modal",
		query: "Where are resource coordinates resolved by checking each source's nested location coordinates first, then falling back to its position?",
		expect: {
			file: "src/components/map/modal/modalResourceInfoLocation.ts",
			contains: "export const resolveResourceLocation =",
			startLine: 29,
		},
		notes: "Same target with sibling UI files competing for navigation.",
	},
	{
		id: "fe-travel-distance",
		title: "Travel distance fallback",
		path: "src/components/map/modal",
		query: "Where does army travel use an already supplied positive distance, otherwise derive the distance from origin and target coordinates, returning zero for invalid coordinates?",
		expect: {
			file: "src/components/map/modal/armyTravelTime.ts",
			contains: "export const resolveTravelDistanceMeters =",
			startLine: 66,
		},
		notes: "Multiline destructured arrow-function declaration with numeric guards.",
	},
	{
		id: "fe-reward-target",
		title: "Inventory reward animation destination",
		path: "src/components/features/Bag/utils",
		query: "Where is the destination for an inventory-use reward animation chosen between the VIP badge, a resource counter, the money counter, and the bag?",
		expect: {
			file: "src/components/features/Bag/utils/bagRewardFly.ts",
			contains: "export const getBagItemRewardFlyTarget =",
			startLine: 10,
		},
		notes: "Inventory UI logic with similarly named helpers.",
	},
	{
		id: "fe-reward-icon",
		title: "Inventory reward icon fallback",
		path: "src/components/features/Bag/utils/bagRewardFly.ts",
		query: "Where is the item-use reward animation record built, resolving its icon, returning null without an icon, multiplying value by quantity and setting the number of flying icons?",
		expect: {
			file: "src/components/features/Bag/utils/bagRewardFly.ts",
			contains: "export const buildBagItemUseFlyItem =",
			startLine: 26,
		},
		notes: "Different target in the same file; distinguishes choosing a destination from building animation metadata.",
	},
	{
		id: "fe-quest-file",
		title: "Daily quest stable partition",
		path: "src/components/features/quest/utils/sortDailyQuests.ts",
		query: "Where are claimed daily quests placed after active quests while preserving the original order within each group?",
		expect: {
			file: "src/components/features/quest/utils/sortDailyQuests.ts",
			contains: "export const sortDailyQuestsForDisplay =",
			startLine: 5,
		},
		notes: "Small pure utility with a misleading nearby claimed-state predicate.",
	},
	{
		id: "fe-quest-wide",
		title: "Daily quest partition, broad feature scope",
		path: "src/components/features",
		query: "Where are claimed daily quests placed after active quests while preserving the original order within each group?",
		expect: {
			file: "src/components/features/quest/utils/sortDailyQuests.ts",
			contains: "export const sortDailyQuestsForDisplay =",
			startLine: 5,
		},
		notes: "Multi-level navigation through a large feature hierarchy with the default budget.",
	},
	{
		id: "fe-hero-file",
		title: "Optimistic hero rank timer",
		path: "src/components/features/Hero/heroTimerPatch.ts",
		query: "Where is cached hero rank updated optimistically with an upgrade flag, an end timestamp, the old rank and the next rank, returning null when cached rank is absent?",
		expect: {
			file: "src/components/features/Hero/heroTimerPatch.ts",
			contains: "export const patchHeroRankUpgradeOptimistic =",
			startLine: 82,
		},
		notes: "State transformation near the end of a file with similar timer patches.",
	},
	{
		id: "fe-hero-vietnamese",
		title: "Vietnamese hero query with directory navigation",
		path: "src/components/features/Hero",
		query: "Hàm nào cập nhật ngay cache khi nâng rank hero: đặt cờ đang nâng, thời điểm kết thúc, rank cũ và rank kế tiếp; trả null nếu thiếu rank trong cache?",
		expect: {
			file: "src/components/features/Hero/heroTimerPatch.ts",
			contains: "export const patchHeroRankUpgradeOptimistic =",
			startLine: 82,
		},
		notes: "Vietnamese semantic query; target identifier is not supplied.",
	},
	{
		id: "fe-building-tsx",
		title: "Building click iframe bridge in TSX",
		path: "src/components/devtools/BuildingClickDebugOverlay.tsx",
		query: "Where does the building debug UI send a building click from the embedded game iframe to its parent, returning false if the iframe document is unavailable?",
		expect: {
			file: "src/components/devtools/BuildingClickDebugOverlay.tsx",
			contains: "const clickBuildingViaIframe =",
			startLine: 25,
		},
		notes: "Non-exported helper inside a TSX component file; no browser interaction.",
	},
	{
		id: "fe-negative-near",
		title: "Related but absent frontend behavior",
		path: "src/components/features/quest/utils/sortDailyQuests.ts",
		query: "Where does claiming a daily quest send the reward request to the server and update the player's inventory?",
		expect: null,
		notes: "Same domain, wrong operation: this source only orders quests for display.",
	},
	{
		id: "fe-negative-far",
		title: "Unrelated absent frontend behavior",
		path: "src/components/map/modal/modalResourceInfoLocation.ts",
		query: "Where are interplanetary spacecraft trajectories integrated from gravitational acceleration?",
		expect: null,
		notes: "Negative control against coordinate vocabulary, not repository-wide absence.",
	},
];
