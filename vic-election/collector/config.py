"""Static configuration for the 2026 Victorian state election tracker."""

VEC = "https://www.vec.vic.gov.au"

# Lower house: 88 districts. Slugs match VEC URL fragments ("<slug>-district-results").
DISTRICT_SLUGS = """albert-park ashwood bass bayswater bellarine benambra bendigo-east bendigo-west
bentleigh berwick box-hill brighton broadmeadows brunswick bulleen bundoora carrum caulfield
clarinda cranbourne croydon dandenong eildon eltham essendon eureka euroa evelyn footscray
frankston geelong gippsland-east gippsland-south glen-waverley greenvale hastings hawthorn
ivanhoe kalkallo kew kororoit lara laverton lowan macedon malvern melbourne melton mildura
mill-park monbulk mordialloc mornington morwell mulgrave murray-plains narracan
narre-warren-north narre-warren-south nepean niddrie northcote oakleigh ovens-valley pakenham
pascoe-vale point-cook polwarth prahran preston richmond ringwood ripon rowville sandringham
shepparton south-barwon south-west-coast st-albans sunbury sydenham tarneit thomastown
warrandyte wendouree werribee williamstown yan-yean""".split()

# Upper house: 8 regions x 5 members.
REGION_SLUGS = [
    "eastern-victoria", "north-eastern-metropolitan", "northern-metropolitan",
    "northern-victoria", "south-eastern-metropolitan", "southern-metropolitan",
    "western-metropolitan", "western-victoria",
]

# Seats flagged before the election as One Nation targets (ABC, Roy Morgan, AAP coverage).
WATCH_SEATS = {
    "pakenham": "Leader Warren Pickering's seat; outer south-east Melbourne",
    "morwell": "One Nation's best 2022 state result and best 2025 Senate result",
    "hastings": "Roy Morgan projected a One Nation win",
    "melton": "38% minor-party and independent vote in 2022",
    "sunbury": "Outer-suburban target",
    "narracan": "Gippsland seat with strong past One Nation Senate vote",
    "gippsland-east": "Regional seat with strong past One Nation Senate vote",
    "kororoit": "Western suburbs seat where minor parties surged in 2022",
    "greenvale": "Northern suburbs seat where minor parties surged in 2022",
    "st-albans": "Western suburbs seat where minor parties surged in 2022",
    "sydenham": "Western suburbs seat where minor parties surged in 2022",
    "bass": "Contested outer seat; Roy Morgan expected a Liberal win",
}

MAJORITY = 45          # of 88 Assembly seats
COUNCIL_MAJORITY = 21  # of 40 Council seats
REGION_QUOTA = 1 / 6   # 5 vacancies -> quota is 1/(5+1) of formal votes

# Index pages crawled to discover where the VEC publishes 2026 results.
DISCOVERY_SEEDS = [
    "/results/state-election-results",
    "/results",
    "/voting/current-elections",
    "/voting/2026-state-election",
    "/",
]

# Fallback bases tried if crawling finds nothing. Each is a prefix that should
# contain results-by-district/<slug>-district-results.
CANDIDATE_BASES = [
    "/results/state-election-results/2026-state-election-results",
    "/voting/current-elections/2026-state-election/2026-state-election-results",
    "/voting/current-elections/2026-state-election-results",
    "/voting/2026-state-election/2026-state-election-results",
    "/voting/2026-state-election/results",
    "/voting/current-elections/state-election-2026/state-election-2026-results",
]
