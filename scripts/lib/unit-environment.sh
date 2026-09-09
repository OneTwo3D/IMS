# shellcheck shell=bash
# =============================================================================
# WHAT CAN DEFINE ONE VARIABLE FOR THIS SERVICE — ONE DEFINITION, THREE READERS
# =============================================================================
# o3d-rret. Sourced by scripts/install.sh, scripts/deploy.sh and scripts/update.sh, and it is the
# ONLY place in this repository that asks systemd what composes a service's environment.
#
# WHY IT IS A LIBRARY AND NOT A THIRD COPY. The same argument cutover-namespace.sh makes, and this
# is the fourth time it has been the finding. The doctrine below was written for DATABASE_URL in
# r20; r28 found update.sh reading `Environment=PORT=` as authoritative one screen below the
# paragraph that says a directive is not the composed environment, and made the scan take the
# VARIABLE and the LAYER as arguments; r44 found install.sh still carrying the un-parameterised
# copy and ported it. deploy.sh was never ported, so until o3d-rret this repository held ONE rule
# in THREE hand-written implementations, two of which had been generalised and one of which had
# not — and PR #664 rewrote all three files without noticing. A rule about what may define a
# service's connection identity cannot be stated in two of three entrypoints and be one rule.
#
# THE TWO GENERALISED COPIES WERE NOT THE SAME EITHER, WHICH IS THE ARGUMENT RESTATED. update.sh's
# took (variable, layer, env_file, units...); install.sh's took (variable, env_file, units...),
# because r45 removed a `layer` whose only value — `none` — was broken and whose only caller had
# gone. Everything else in the two bodies was byte-identical. The form below is update.sh's: the
# `layer` argument survives because it has two live callers here (`file` for DATABASE_URL,
# `directive` for PORT) and NOT because r45's `none` is coming back. There is no `none` layer, and
# nothing in this file opens an environment file — for the reason r19 and r28 both gave: WHICH of
# several definitions systemd would keep is composition these scripts do not reproduce.
#
# WHAT THE CALLERS STILL OWN. `DB_IDENTITY_SOURCE_REASON` is the DATABASE_URL call sites' own
# message state and is declared by each entrypoint, in its own place, because install.sh assigns it
# twice and moving the initialisation here would change which assignment is in effect. Everything
# this file's functions read or write themselves — BUS_STRINGS, BUS_ENV_IGNORE_FLAGS,
# DB_IDENTITY_REQUIRE_SNAPSHOT, ENV_VAR_SOURCE_REASON — is declared here, with them.
#
# The entrypoints supply the environment-snapshot globals the `file` layer reads:
# DB_ENV_SNAPSHOT_FILE, DB_ENV_SNAPSHOT_DROPIN_NAME and DB_ENV_SNAPSHOT_PUBLISHED. They are read at
# CALL time, long after this file is sourced, exactly as cutover-namespace.sh reads CUTOVER_ROOT_DIR.

# WHAT CAN DEFINE ONE VARIABLE FOR THIS SERVICE?
# (o3d-2sm1.5 r20, Codex CRITICAL; r21 asks systemd's BUS instead of its text output;
#  r28 makes it ONE MECHANISM asked of a NAMED VARIABLE, Codex HIGH)
#
# IT IS ONE MECHANISM, NOT ONE PER VARIABLE. Until r28 this was written for DATABASE_URL alone,
# and the round that added the port resolver read `Environment=PORT=` as authoritative — in this
# same file, one screen below the reasoning that says a directive is not the composed
# environment. Two variables, one doctrine, applied to one of them. So the scan takes the
# VARIABLE NAME and the LAYER that is allowed to answer for it as arguments, and a third variable
# cannot repeat the omission by being forgotten: there is nowhere else to ask the question.
#
#   layer=file       the named environment file is the only permitted definition. An
#                    `Environment=` directive competes with it and is refused. This is how the
#                    connection identity asks, and every refusal below is written for it.
#   layer=directive  the unit's own `Environment=` is the permitted definition and NO environment
#                    file may be loaded at all, because every one of them is composed later. This
#                    is how unit_listen_port() asks about PORT.
#
# WHAT ELSE IN THESE SCRIPTS READS `Environment=`? Nothing. deploy.sh takes its port from the root
# invocation (IMS_PORT) and install.sh writes the unit rather than reading one; the only other
# `Environment=` reader in any of the three is this scan itself, in each script's copy, and it has
# asked the whole composition question since r21. PORT was the one value read from a directive
# with the assumption, and it is the one fixed here.
#
# r19 moved the identity from "worked out by the fence" to "supplied by the entrypoint", and the
# entrypoint supplies it out of ${APP_DIR_REAL}/.env. That is the PREVIOUS PROBLEM ONE LEVEL UP: an
# `Environment=DATABASE_URL=...` directive, a drop-in that adds one, a `PassEnvironment=` entry, a
# `PAMName=` whose PAM stack exports one, or a second `EnvironmentFile=` can put a different URL in
# the service's environment, and dotenv does NOT overwrite a variable that is already set. The
# fence, the migration and the release would then all be self-consistent about the .env database
# while the restarted application connects elsewhere — a migration run on a database nothing was
# fenced off, and a new build started against a database nothing migrated.
#
# THIS DOES NOT REBUILD THE INFERENCE r19 DELETED, and the difference is the whole design. It
# computes no value and reproduces no precedence. It asks ONE existence question about ONE
# variable:
#
#     can anything other than the file we read define DATABASE_URL for this unit?
#
# systemd answers that directly, because it reports the COMPOSED Environment=, EnvironmentFiles=,
# PassEnvironment=, UnsetEnvironment= and PAMName= with every drop-in already folded in by systemd
# itself. Asking whether a second definition EXISTS is bounded; working out which of several would
# WIN is the unbounded question, and it is never asked — any answer but "only that file" is a
# refusal that names what else defines it and tells the operator to state the identity explicitly.
# A second environment file is refused WITHOUT being read, for the same reason: that it may define
# the variable is enough, and reading it to find out would put the precedence question straight
# back. A non-empty PAMName= is refused without reading PAM configuration, for that same reason
# again.
#
# IT IS ASKED OF THE BUS, NOT OF `systemctl show` (r21, Codex CRITICAL). Two of r20's three
# findings were text-parsing bugs and only text-parsing bugs: `systemctl show` renders a property
# as one `Name=` line of space-joined values, so where one entry of an ARRAY ends and the next
# begins has to be guessed at — and `EnvironmentFiles` is an array of (path, ignore_errors) PAIRS
# whose rendering the previous reader truncated at the first ` (ignore_errors=`. `busctl` — the
# same package, on every host that has systemctl — prints the property's SIGNATURE and the array's
# own ELEMENT COUNT before the elements:
#
#     a(sb) 1 "/opt/app/.env" true          as 2 "NODE_ENV=production" "PORT=3000"          s ""
#
# so "is there more than one environment file?" is answered by systemd's own data structure. The
# count is read from the rendering and checked against the number of elements found in it; a
# disagreement is a refusal. Nothing is inferred from where a space falls, and a string systemd had
# to escape (busctl prints strings through `cescape()`) is REFUSED rather than decoded — decoding
# it here would be one more reimplementation of somebody else's rules.
#
# EVERY ENVIRONMENT PROPERTY IS THEN MATCHED THE SAME WAY: on the NAME of each element, which is
# everything before its first `=`. That is what makes `UnsetEnvironment=DATABASE_URL=<the value in
# the .env>` a refusal (r21, Codex HIGH): systemd.exec takes "a space-separated list of variable
# names or variable assignments", removes an exact assignment as the FINAL step of composing the
# environment, and a scan for the bare token `DATABASE_URL` sees no such token in it — after which
# the application's own dotenv loader supplies whatever `.env.local` says. The same rule applies to
# Environment=, PassEnvironment= and UnsetEnvironment= alike, so no spelling of any of them is
# matched by a substring.
#
# THE FILE MUST ALSO BE ONE SYSTEMD ITSELF LOADS. If the unit loads no environment file, the
# variable reaches the application through the application's OWN loader instead, by rules that
# belong to Next and not to systemd — `.env.local` and the per-mode overlays, which is precisely
# the layer r19 stopped reproducing. So that is a refusal too, and it says which line to add.
#
# WHAT IT CANNOT SEE, STATED RATHER THAN PAPERED OVER: an `ExecStart=` that runs a wrapper which
# exports DATABASE_URL itself is invisible to systemd's own properties, because that definition
# lives inside a program rather than in the unit. Closing that would mean reading programs, which
# is unbounded again. It is the standing argument for making the four values a DEPLOYMENT-OWNED
# CONFIGURATION INPUT that these scripts read outright, instead of deriving them from a URL that
# is only probably the one the service uses (o3d-1yvh, docs/installation.md).

# The parameterised mechanism's own answer. DB_IDENTITY_SOURCE_REASON — declared by each
# entrypoint, for the reason the header gives — is what the DATABASE_URL call sites read, and
# env_file_is_sole_database_url_source() copies this into it.
ENV_VAR_SOURCE_REASON="no variable's environment sources have been asked about yet"
BUS_STRINGS=()

# THE STRINGS IN ONE `busctl` RENDERING, in order, STILL ESCAPED.
#
# busctl prints every string through `cescape()`, so a `"` inside a value arrives as `\"` and
# cannot end it early. This walks the rendering with that one rule and keeps the escapes: the
# callers compare against names and paths that contain none, and refuse anything that does.
# Returns 1 for a rendering whose quoting does not close, which is a rendering this cannot read.
bus_read_strings() {
  local text="${1:-}" index=0 length char current='' inside=0
  BUS_STRINGS=()
  length=${#text}
  while (( index < length )); do
    char="${text:index:1}"
    if (( inside )); then
      if [[ "$char" == '\' ]]; then
        (( index + 1 < length )) || return 1
        index=$(( index + 1 ))
        current+="\\${text:index:1}"
      elif [[ "$char" == '"' ]]; then
        BUS_STRINGS+=("$current")
        current=''
        inside=0
      else
        current+="$char"
      fi
    elif [[ "$char" == '"' ]]; then
      inside=1
      current=''
    fi
    index=$(( index + 1 ))
  done
  (( inside == 0 )) || return 1
  return 0
}

# THE ELEMENT COUNT systemd states in front of an array, for the signature we asked for.
#
# This is the number that makes the question bounded: it comes from the array, not from counting
# separators in a line. A rendering of another signature — or none — is not an answer, and the
# caller refuses.
bus_array_count() {
  local text="${1:-}" signature="${2:-}" rest
  [[ "$text" == "${signature} "* ]] || return 1
  rest="${text#"${signature}" }"
  rest="${rest%% *}"
  [[ "$rest" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$rest"
}

# One property of one unit, as systemd's own bus states it.
bus_unit_property() {
  busctl get-property org.freedesktop.systemd1 "${1:-}" "org.freedesktop.systemd1.${2:-}" "${3:-}" 2>/dev/null
}

# Does this element of an environment property NAME the variable being asked about? Everything
# before the first `=` is the name, so `DATABASE_URL`, `DATABASE_URL=postgresql://...` and an
# assignment carrying any value at all are one answer, and `NEXT_PUBLIC_DATABASE_URL=...` is not.
# The variable is an ARGUMENT since r28: the same rule answers for PORT, and for whatever a later
# round has to ask about, without a second matcher being written for it.
bus_element_names_variable() {
  [[ "${1%%=*}" == "${2}" ]]
}

# THE `ignore_errors` HALF OF EnvironmentFiles=, which is an `a(sb)` and not an `as`
# (o3d-2sm1.5 r23, Codex HIGH). bus_read_strings() reads the paths and drops the booleans; the
# snapshot check needs them, because a snapshot loaded with a leading `-` is not a binding at
# all — systemd would SKIP it if it were missing and hand the service back to whatever else
# defines DATABASE_URL, which is the failure this round exists to remove.
#
# Every quoted element is removed first, which leaves the signature, systemd's own element count
# and the booleans in order. Nothing here reimplements systemd's escaping: the callers already
# refuse any element that had to be escaped.
BUS_ENV_IGNORE_FLAGS=()
bus_read_env_ignore_flags() {
  local text="${1:-}" stripped word index=0
  BUS_ENV_IGNORE_FLAGS=()
  stripped="$(printf '%s' "$text" | sed 's/"\(\\.\|[^"\\]\)*"/ /g')" || return 1
  local IFS=' '
  local -a words=()
  # shellcheck disable=SC2206  # deliberate word split on the space-separated rendering
  words=($stripped)
  for (( index = 2; index < ${#words[@]}; index++ )); do
    word="${words[index]}"
    case "$word" in
      true|false) BUS_ENV_IGNORE_FLAGS+=("$word") ;;
      *) return 1 ;;
    esac
  done
  return 0
}

# Does the caller also REQUIRE the environment snapshot to be loaded? False everywhere the
# question is only "is anything else defining DATABASE_URL"; true at the one call site that is
# about to hand the units to systemd (o3d-2sm1.5 r23).
DB_IDENTITY_REQUIRE_SNAPSHOT=false

unit_env_var_sole_source() {
  local variable="${1:-}" layer="${2:-}" env_file="${3:-}"; shift 3 2>/dev/null || true
  local -a units=("$@")
  local unit object rendering count element expected resolved load_state pam_name snapshot_expected

  ENV_VAR_SOURCE_REASON=""
  expected="$(readlink -f "$env_file" 2>/dev/null || printf '%s' "$env_file")"
  snapshot_expected="$(readlink -f "$DB_ENV_SNAPSHOT_FILE" 2>/dev/null || printf '%s' "$DB_ENV_SNAPSHOT_FILE")"

  if [[ "${#units[@]}" -eq 0 || -z "${units[0]}" ]]; then
    ENV_VAR_SOURCE_REASON="no systemd unit was identified for the application, so there is nothing that can say whether ${env_file} is what gives it ${variable}"
    return 1
  fi
  if ! command -v busctl >/dev/null 2>&1; then
    ENV_VAR_SOURCE_REASON="busctl — systemd's own bus client, shipped beside systemctl — is not available, so whether anything other than ${env_file} defines ${variable} for the service cannot be established"
    return 1
  fi

  for unit in "${units[@]}"; do
    [[ -n "$unit" ]] || continue

    # LoadUnit, not GetUnit: it answers for a unit the manager has not loaded yet as well, so the
    # LoadState below is what says whether there is a readable unit there at all. It is the same
    # load `systemctl show` performs — it starts nothing and queues no job.
    rendering="$(busctl call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager LoadUnit s "$unit" 2>/dev/null)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 || -z "${BUS_STRINGS[0]}" ]]; then
      ENV_VAR_SOURCE_REASON="systemd would not say where ${unit} lives on its bus, so what defines ${variable} for that service is unknown"
      return 1
    fi
    object="${BUS_STRINGS[0]}"

    rendering="$(bus_unit_property "$object" Unit LoadState)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 ]]; then
      ENV_VAR_SOURCE_REASON="systemd would not answer for ${unit}'s LoadState, so what defines ${variable} for that service is unknown"
      return 1
    fi
    load_state="${BUS_STRINGS[0]}"
    if [[ "$load_state" != "loaded" ]]; then
      ENV_VAR_SOURCE_REASON="systemd reports ${unit} as '${load_state:-unknown}' rather than loaded, so what defines ${variable} for it cannot be read"
      return 1
    fi

    # PAMName=, which the five-property question did not ask (r21, Codex CRITICAL). systemd.exec
    # lists "variables set by any PAM modules in case PAMName= is in effect" AFTER the
    # EnvironmentFile= layer and says the later source wins, so a unit naming a PAM profile whose
    # stack runs pam_env can be handed a ${variable} that beats the file this deploy read — while
    # every other property here still says "only that file". What a PAM stack supplies is not
    # knowable without reading PAM configuration, so ANY non-empty value is refused.
    rendering="$(bus_unit_property "$object" Service PAMName)" || rendering=''
    if ! bus_read_strings "$rendering" || [[ "${#BUS_STRINGS[@]}" -ne 1 ]]; then
      ENV_VAR_SOURCE_REASON="systemd would not answer for ${unit}'s PAMName=, so whether a PAM stack also defines ${variable} for it is unknown"
      return 1
    fi
    pam_name="${BUS_STRINGS[0]}"
    if [[ -n "$pam_name" ]]; then
      ENV_VAR_SOURCE_REASON="${unit} sets PAMName=${pam_name}, and systemd applies the variables its PAM modules set AFTER the environment file — the later source wins. Whether that stack exports ${variable} is a question about PAM configuration this will not read, so it is refused rather than guessed at. Remove PAMName=, or state the connection identity explicitly"
      return 1
    fi

    # The three environment lists, all matched on the element NAME. UnsetEnvironment= takes a name
    # OR an exact assignment and is applied as the final composition step, so the assignment form
    # is the same refusal as the bare name (r21, Codex HIGH).
    local property description
    for property in Environment PassEnvironment UnsetEnvironment; do
      # WHICH LAYER IS ALLOWED TO DEFINE IT. For `file` — the ${variable} question as the database
      # identity asks it — the environment file is the permitted source, so an `Environment=`
      # directive is a COMPETING definition and a refusal. For `directive` — how the port asks it —
      # the unit's own `Environment=` IS what the caller read, so it is not asked about again here.
      # Every LATER composition source still is, in both.
      if [[ "$property" == "Environment" && "$layer" == "directive" ]]; then continue; fi
      rendering="$(bus_unit_property "$object" Service "$property")" || rendering=''
      if ! count="$(bus_array_count "$rendering" 'as')" || ! bus_read_strings "$rendering" \
        || [[ "${#BUS_STRINGS[@]}" -ne "$count" ]]; then
        ENV_VAR_SOURCE_REASON="systemd would not answer readably for ${unit}'s ${property}=, so what defines ${variable} for that service is unknown"
        return 1
      fi
      for element in ${BUS_STRINGS[@]+"${BUS_STRINGS[@]}"}; do
        bus_element_names_variable "$element" "$variable" || continue
        case "$property" in
          Environment) description="sets ${variable} in its own Environment= (${element%%=*}=…). systemd puts that in the service's environment and dotenv will not overwrite an already-set variable, so the application connects where THAT says and not where ${env_file} says" ;;
          PassEnvironment) description="lists ${variable} in PassEnvironment=, so the service inherits whatever the service manager's own environment holds and ${env_file} does not decide where the application connects" ;;
          *) description="lists ${variable} in UnsetEnvironment= (as '${element}'), so systemd removes the value ${env_file} supplies — as the final step of composing the environment, whether it is written as a name or as an exact assignment — and the application's own loader decides what replaces it" ;;
        esac
        ENV_VAR_SOURCE_REASON="${unit} ${description}. Remove it, or state the connection identity explicitly"
        return 1
      done
    done

    # EnvironmentFiles=, an array of (path, ignore_errors) pairs. EXACTLY ONE entry, and it must
    # be ours: the count is systemd's own, so a second file cannot hide behind the rendering.
    rendering="$(bus_unit_property "$object" Service EnvironmentFiles)" || rendering=''
    if ! count="$(bus_array_count "$rendering" 'a(sb)')" || ! bus_read_strings "$rendering" \
      || [[ "${#BUS_STRINGS[@]}" -ne "$count" ]]; then
      ENV_VAR_SOURCE_REASON="systemd would not answer readably for ${unit}'s EnvironmentFiles=, so what defines ${variable} for that service is unknown"
      return 1
    fi
    # THE `directive` LAYER TOLERATES NO ENVIRONMENT FILE AT ALL (o3d-2sm1.5 r28, Codex HIGH).
    # systemd.exec is explicit that EnvironmentFile= is applied AFTER Environment=, so a file the
    # unit loads can redefine the variable the directive states — and the file THIS service loads
    # is written by the APPLICATION USER. Which definition wins is the unbounded precedence
    # question this script never asks, and opening the file to find out is what r19 stopped doing,
    # so the EXISTENCE of any file is the refusal. It names the alternative, which for the port is
    # the one place a later environment source cannot reach: ExecStart=.
    if [[ "$layer" == "directive" ]]; then
      if [[ "$count" -ne 0 ]]; then
        ENV_VAR_SOURCE_REASON="${unit} states ${variable} in its own Environment=, and it also loads ${count} environment file(s) (${BUS_STRINGS[*]}). systemd applies EnvironmentFile= AFTER Environment=, so any of those files can define ${variable} differently and the service would use THAT value while the unit's directive still reads as the answer. They are not opened here, because which definition would win is composition this script does not reproduce. Pin it in ExecStart= instead, where nothing composed later can move it, or state it on this run's invocation"
        return 1
      fi
      continue
    fi
    if [[ "$count" -eq 0 ]]; then
      ENV_VAR_SOURCE_REASON="${unit} does not load ${env_file} with EnvironmentFile=, so ${variable} reaches the application through its own dotenv loader instead — whose .env.local and per-mode overlays are exactly the composition this deploy stopped reproducing. Add EnvironmentFile=${env_file} to the unit, or state the connection identity explicitly"
      return 1
    fi
    # ONE ENVIRONMENT FILE, OR TWO OF WHICH THE SECOND IS THIS RUN'S OWN SNAPSHOT
    # (o3d-2sm1.5 r23, Codex HIGH). Until this round the answer was "exactly one, and it must be
    # ${env_file}" — which is the right refusal for somebody ELSE's second file and the wrong one
    # for the binding this round adds, since publish_db_identity_snapshot() gives every unit a
    # drop-in that loads ${DB_ENV_SNAPSHOT_FILE} after it. So the shape is stated exactly: the
    # application's file first, and at most one more, which may only be the snapshot THIS RUN
    # published. A snapshot left behind by some earlier run is NOT tolerated — DB_ENV_SNAPSHOT_PUBLISHED
    # is false until this run writes one — because an unexplained pin is a ${variable} nobody
    # here chose, which is precisely the condition this function exists to refuse.
    if [[ "$count" -gt 2 ]]; then
      ENV_VAR_SOURCE_REASON="${unit} loads ${count} environment files (${BUS_STRINGS[*]}). Whether any of them but ${env_file} defines ${variable}, and which definition systemd would keep, is composition this will not reproduce — so it is refused rather than guessed at, and without reading them. Load only ${env_file}, or state the connection identity explicitly"
      return 1
    fi
    if ! bus_read_env_ignore_flags "$rendering" || [[ "${#BUS_ENV_IGNORE_FLAGS[@]}" -ne "$count" ]]; then
      ENV_VAR_SOURCE_REASON="systemd would not say readably whether ${unit} loads its environment files with a leading '-'. Whether a missing file is skipped or fatal decides what the service gets when one disappears, so it is refused rather than assumed"
      return 1
    fi
    local index
    for index in 0 1; do
      [[ "$index" -lt "$count" ]] || continue
      element="${BUS_STRINGS[index]}"
      case "$element" in
        *'\'*)
          ENV_VAR_SOURCE_REASON="systemd reports one of ${unit}'s environment files as ${element}, a path it had to escape to state. Decoding that here to compare it with ${env_file} is a reimplementation of somebody else's escaping, so it is refused: give the unit an EnvironmentFile= path with no character needing an escape, or state the connection identity explicitly"
          return 1 ;;
      esac
      resolved="$(readlink -f "$element" 2>/dev/null || printf '%s' "$element")"
      if [[ "$index" -eq 0 ]]; then
        if [[ "$resolved" != "$expected" ]]; then
          ENV_VAR_SOURCE_REASON="${unit} loads ${element} as its first environment file and not ${env_file}, so the file this deploy read is not the one that gives the service ${variable}. Load ${env_file}, or state the connection identity explicitly"
          return 1
        fi
        continue
      fi
      # THE SECOND ENTRY, WHICH MAY ONLY BE THE BINDING. Three things are required of it and each
      # is load-bearing: it is the snapshot's path (anything else is a source of ${variable} this
      # deploy did not write), THIS run published it (an old one pins a value nobody re-validated),
      # and it is loaded WITHOUT a leading '-' (with one, deleting it between here and the exec
      # takes the binding away silently and hands the service back to ${env_file}).
      if ! $DB_ENV_SNAPSHOT_PUBLISHED; then
        ENV_VAR_SOURCE_REASON="${unit} loads a second environment file, ${element}, that this run did not publish. A second file can define ${variable} and systemd keeps the LAST definition, so what the service would connect to is not ${env_file}'s answer. Remove it (if it is a ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in, an earlier cutover left it behind and it is safe to delete), or state the connection identity explicitly"
        return 1
      fi
      if [[ "$resolved" != "$snapshot_expected" ]]; then
        ENV_VAR_SOURCE_REASON="${unit} loads ${element} as a second environment file, and this run's environment snapshot is ${DB_ENV_SNAPSHOT_FILE}. A second file can define ${variable} and systemd keeps the LAST definition, so the service would connect where that file says. Remove it, or state the connection identity explicitly"
        return 1
      fi
      if [[ "${BUS_ENV_IGNORE_FLAGS[index]}" != "false" ]]; then
        ENV_VAR_SOURCE_REASON="${unit} loads ${element} with a leading '-', so systemd SKIPS it if it is missing instead of failing the start. The whole point of the snapshot is that its absence stops the service rather than handing it back to ${env_file}; drop the '-' from the ${DB_ENV_SNAPSHOT_DROPIN_NAME} drop-in"
        return 1
      fi
    done
    # AND WHEN THE CALLER IS ABOUT TO START THE SERVICE, THE BINDING MUST BE THERE. Everywhere
    # else this function is a refusal of extra sources; at the start it is also the proof that the
    # one source that cannot be replaced under us is loaded.
    if $DB_IDENTITY_REQUIRE_SNAPSHOT && [[ "$count" -ne 2 ]]; then
      ENV_VAR_SOURCE_REASON="${unit} does not load this run's environment snapshot ${DB_ENV_SNAPSHOT_FILE}, so the ${variable} it gets at exec is whatever ${env_file} says at that moment and not the one this run fenced and migrated"
      return 1
    fi
  done
  return 0
}

# THE DATABASE IDENTITY'S NAME FOR THE QUESTION, and all that is left of the function that used to
# be it: the same scan, told which variable to ask about and which layer is allowed to answer.
# Four call sites read `require_env_file_is_sole_definition` exactly as they always did.
env_file_is_sole_database_url_source() {
  local rc=0
  unit_env_var_sole_source DATABASE_URL file "$@" || rc=$?
  DB_IDENTITY_SOURCE_REASON="$ENV_VAR_SOURCE_REASON"
  return "$rc"
}
