import os
import re
import sys
import time
import pickle
import atexit
import argparse
from collections import Counter, defaultdict
from difflib import SequenceMatcher
import torch

SUBDIRECTORY = "sorting_workspace"
os.makedirs(SUBDIRECTORY, exist_ok=True)

SEMANTIC_MODEL = None

def load_semantic_model():
    global SEMANTIC_MODEL
    if SEMANTIC_MODEL is not None:
        return True
    try:
        from sentence_transformers import SentenceTransformer
        SEMANTIC_MODEL = SentenceTransformer('all-MiniLM-L6-v2')
        return True
    except ImportError:
        return False

class TelemetryTracker:
    def __init__(self):
        self.start_time = 0.0
        self.total_phrases = 0
        self.processed_count = 0
        self.total_comparison_time = 0.0
        self.total_comparisons_run = 0
        self.current_phrase_text = ""
        self.top_candidates = []  
        self.tiers = [0] * 10  
        self.factor_counts = 0
        self.raw_semantic_sum = 0.0
        self.raw_align_sum = 0.0
        self.raw_matcher_sum = 0.0
        self.is_cancelled = False  

    def reset_pass_counters(self, phrase_text):
        self.current_phrase_text = phrase_text
        self.top_candidates = []
        self.tiers = [0] * 10

    def register_comparison(self, score, raw_factors):
        tier_idx = min(int(score * 10), 9)
        if tier_idx < 0: 
            tier_idx = 0
        self.tiers[tier_idx] += 1
        self.factor_counts += 1
        self.raw_semantic_sum += raw_factors.get("semantic", 0.0)
        self.raw_align_sum += raw_factors.get("alignment", 0.0)
        self.raw_matcher_sum += raw_factors.get("phrase_matcher", 0.0)

class DiskCacheManager:
    def __init__(self):
        self.cache = {
            "sequence_matcher": {},
            "custom_alignment": {},
            "similarity_score": {},
            "syllables": {}
        }
        self.current_path = os.path.join(SUBDIRECTORY, "similarity_cache.pkl")
        atexit.register(self.save_cache)

    def load_cache(self, filepath):
        self.current_path = filepath
        try:
            with open(filepath, "rb") as f:
                self.cache = pickle.load(f)
        except Exception:
            self.cache = {
                "sequence_matcher": {},
                "custom_alignment": {},
                "similarity_score": {},
                "syllables": {}
            }
        _LOCAL_WORD_CACHE.clear()
        _LOCAL_ALIGNMENT_CACHE.clear()
        _LOCAL_SYLLABLE_CACHE.clear()

    def save_cache(self):
        try:
            with open(self.current_path, "wb") as f:
                pickle.dump(self.cache, f)
        except Exception:
            pass

LIVE_TELEMETRY = TelemetryTracker()
CACHE_ENGINE = DiskCacheManager()

_LOCAL_WORD_CACHE = {}
_LOCAL_ALIGNMENT_CACHE = {}
_LOCAL_SYLLABLE_CACHE = {}

def cached_sequence_matcher(w1, w2):
    key = (w1, w2)
    if key in _LOCAL_WORD_CACHE:
        return _LOCAL_WORD_CACHE[key]
    
    disk_cache = CACHE_ENGINE.cache["sequence_matcher"]
    if key in disk_cache:
        val = disk_cache[key]
        _LOCAL_WORD_CACHE[key] = val
        return val
        
    res = SequenceMatcher(None, w1, w2).ratio()
    disk_cache[key] = res
    _LOCAL_WORD_CACHE[key] = res
    return res

def compute_custom_alignment(words1, words2):
    key = (tuple(words1), tuple(words2))
    if key in _LOCAL_ALIGNMENT_CACHE:
        return _LOCAL_ALIGNMENT_CACHE[key]
        
    disk_cache = CACHE_ENGINE.cache["custom_alignment"]
    if key in disk_cache:
        val = disk_cache[key]
        _LOCAL_ALIGNMENT_CACHE[key] = val
        return val

    len1, len2 = len(words1), len(words2)
    if len1 == 0 or len2 == 0:
        return 0.0
        
    total_alignment_score = 0.0
    for i, w1 in enumerate(words1):
        rel_pos1 = i / len1 if len1 > 1 else 0.0
        best_word_contribution = -1.0 
        
        for j, w2 in enumerate(words2):
            rel_pos2 = j / len2 if len2 > 1 else 0.0
            distance = abs(rel_pos1 - rel_pos2)
            
            word_sim = cached_sequence_matcher(w1, w2)
            if word_sim > 0.4:
                contribution = word_sim * (1.0 - (2.0 * distance))
                if contribution > best_word_contribution:
                    best_word_contribution = contribution
                    
        if best_word_contribution != -1.0:
            total_alignment_score += best_word_contribution
            
    res = max(-1.0, min(1.0, total_alignment_score / len1))
    disk_cache[key] = res
    _LOCAL_ALIGNMENT_CACHE[key] = res
    return res

def estimate_syllables(text):
    if text in _LOCAL_SYLLABLE_CACHE:
        return _LOCAL_SYLLABLE_CACHE[text]
        
    disk_cache = CACHE_ENGINE.cache["syllables"]
    if text in disk_cache:
        val = disk_cache[text]
        _LOCAL_SYLLABLE_CACHE[text] = val
        return val

    cleaned = text.lower()
    words = re.findall(r'[a-z]+', cleaned)
    syllable_count = 0
    for word in words:
        vowels = re.findall(r'[aeiouy]+', word)
        count = len(vowels)
        if word.endswith('e') and count > 1:
            count -= 1
        syllable_count += max(1, count)
        
    disk_cache[text] = syllable_count
    _LOCAL_SYLLABLE_CACHE[text] = syllable_count
    return syllable_count

def calculate_similarity(idx1, idx2, phrases, tokenized_phrases, semantic_score, weights):
    t0 = time.perf_counter()
    p1, p2 = phrases[idx1], phrases[idx2]
    cache_key = (p1, p2)
    cached_val = CACHE_ENGINE.cache["similarity_score"].get(cache_key)

    if cached_val is not None and isinstance(cached_val, (tuple, list)):
        score, raw_factors = cached_val
    else:
        w1, w2 = tokenized_phrases[idx1], tokenized_phrases[idx2]
        alignment_factor = compute_custom_alignment(w1, w2)
        phrase_matcher_factor = SequenceMatcher(None, p1, p2).ratio()

        final_score = (
            (semantic_score * weights["semantic"]) +
            (alignment_factor * weights["alignment"]) +
            (phrase_matcher_factor * weights["phrase_matcher"])
        )

        raw_factors = {
            "semantic": semantic_score,
            "alignment": alignment_factor,
            "phrase_matcher": phrase_matcher_factor
        }
        score = max(0.0, final_score)
        CACHE_ENGINE.cache["similarity_score"][cache_key] = (score, raw_factors)
        
    LIVE_TELEMETRY.register_comparison(score, raw_factors)
    LIVE_TELEMETRY.total_comparison_time += (time.perf_counter() - t0)
    LIVE_TELEMETRY.total_comparisons_run += 1
    return score

def load_phrases(filename):
    if not os.path.exists(filename):
        return None
    with open(filename, "r", encoding="utf-8") as f:
        content = f.read()
    return [p.strip() for p in content.split("|") if p.strip()]

def save_phrases(filename, phrases):
    with open(filename, "w", encoding="utf-8") as f:
        f.write(" | ".join(phrases))

def save_disk_cache():
    CACHE_ENGINE.save_cache()

def custom_similarity_sort(phrases, output_file, weights, status_callback):
    if not phrases:
        return []

    unique_groups = defaultdict(list)
    for p in phrases:
        normalized = " ".join(re.sub(r"[^\w\s]", "", p).lower().split())
        unique_groups[normalized].append(p)

    deduplicated_phrases = []
    for normalized, variants in unique_groups.items():
        if len(variants) == 1:
            deduplicated_phrases.append(variants[0])
        else:
            def get_formatting_density(phrase):
                return len(re.sub(r"[\w\s]", "", phrase)) + sum(1 for char in phrase if char.isupper())
            deduplicated_phrases.append(max(variants, key=get_formatting_density))

    phrases = deduplicated_phrases

    status_callback("embedding_start", None)
    t_emb_start = time.perf_counter()
    
    embeddings = SEMANTIC_MODEL.encode(phrases, convert_to_tensor=True, show_progress_bar=False)
    
    emb_duration = time.perf_counter() - t_emb_start
    status_callback("embedding_complete", emb_duration)

    tokenized_phrases = [tuple(re.sub(r"[^\w\s]", "", p).lower().split()) for p in phrases]
    phrase_metadata = [{
        "first_char": p[0].lower() if p else "",
        "length": len(p),
        "formatting_style": "".join(c for c in p if not c.islower() and not c.isspace())
    } for p in phrases]

    remaining_indices = list(range(len(phrases)))
    sorted_indices = [remaining_indices.pop(0)]

    LIVE_TELEMETRY.total_phrases = len(phrases)
    LIVE_TELEMETRY.processed_count = 1
    LIVE_TELEMETRY.start_time = time.time()
    LIVE_TELEMETRY.total_comparison_time = 0.0
    LIVE_TELEMETRY.total_comparisons_run = 0
    LIVE_TELEMETRY.factor_counts = 0
    LIVE_TELEMETRY.raw_semantic_sum = 0.0
    LIVE_TELEMETRY.raw_align_sum = 0.0
    LIVE_TELEMETRY.raw_matcher_sum = 0.0
    LIVE_TELEMETRY.is_cancelled = False

    from sentence_transformers import util

    def compile_payload():
        avg_denom = max(1, LIVE_TELEMETRY.factor_counts)
        comp_denom = max(0.0001, LIVE_TELEMETRY.total_comparison_time)
        return {
            "processed": LIVE_TELEMETRY.processed_count,
            "total": LIVE_TELEMETRY.total_phrases,
            "elapsed": time.time() - LIVE_TELEMETRY.start_time,
            "current_phrase": LIVE_TELEMETRY.current_phrase_text,
            "comparisons_run": LIVE_TELEMETRY.total_comparisons_run,
            "ops_per_sec": LIVE_TELEMETRY.total_comparisons_run / comp_denom,
            "avg_semantic": LIVE_TELEMETRY.raw_semantic_sum / avg_denom,
            "avg_align": LIVE_TELEMETRY.raw_align_sum / avg_denom,
            "avg_matcher": LIVE_TELEMETRY.raw_matcher_sum / avg_denom,
            "tiers": list(LIVE_TELEMETRY.tiers),
            "top_candidates": [(score, p) for score, p in LIVE_TELEMETRY.top_candidates[:3]]
        }

    while remaining_indices:
        if LIVE_TELEMETRY.is_cancelled:
            partial_sorted = [phrases[i] for i in sorted_indices]
            save_phrases(output_file, partial_sorted)
            save_disk_cache()
            status_callback("cancelled", time.time() - LIVE_TELEMETRY.start_time)
            return None

        current_idx = sorted_indices[-1]
        LIVE_TELEMETRY.reset_pass_counters(phrases[current_idx])
        highest_score = -1.0
        best_indices = []

        anchor_emb = embeddings[current_idx].unsqueeze(0)
        rem_embs = embeddings[remaining_indices]
        sim_matrix = util.cos_sim(anchor_emb, rem_embs)[0]
        sim_scores_cpu = sim_matrix.cpu().numpy()

        for idx, rem_idx in enumerate(remaining_indices):
            semantic_score = max(0.0, min(1.0, float(sim_scores_cpu[idx])))
            score = calculate_similarity(current_idx, rem_idx, phrases, tokenized_phrases, semantic_score, weights)

            LIVE_TELEMETRY.top_candidates.append((score, phrases[rem_idx]))
            LIVE_TELEMETRY.top_candidates.sort(key=lambda x: x[0], reverse=True)

            if abs(score - highest_score) < 1e-9:
                best_indices.append(rem_idx)
            elif score > highest_score:
                highest_score = score
                best_indices = [rem_idx]

        status_callback("progress", compile_payload())

        if len(best_indices) > 1:
            current_meta = phrase_metadata[current_idx]
            if current_meta["first_char"]:
                first_char_matches = [i for i in best_indices if phrase_metadata[i]["first_char"] == current_meta["first_char"]]
                if first_char_matches:
                    best_indices = first_char_matches
            
            if len(best_indices) > 1:
                target_len = current_meta["length"]
                min_diff = min(abs(phrase_metadata[i]["length"] - target_len) for i in best_indices)
                best_indices = [i for i in best_indices if abs(phrase_metadata[i]["length"] - target_len) == min_diff]

            if len(best_indices) > 1:
                current_fmt = current_meta["formatting_style"]
                best_fmt_score = -1.0
                fmt_candidates = []
                for idx in best_indices:
                    fmt_score = cached_sequence_matcher(current_fmt, phrase_metadata[idx]["formatting_style"])
                    if abs(fmt_score - best_fmt_score) < 1e-9:
                        fmt_candidates.append(idx)
                    elif fmt_score > best_fmt_score:
                        best_fmt_score = fmt_score
                        fmt_candidates = [idx]
                best_indices = fmt_candidates

            if len(best_indices) > 1:
                target_syllables = estimate_syllables(phrases[current_idx])
                min_syllable_diff = min(abs(estimate_syllables(phrases[i]) - target_syllables) for i in best_indices)
                best_indices = [i for i in best_indices if abs(estimate_syllables(phrases[i]) - target_syllables) == min_syllable_diff]

        if len(best_indices) > 1:
            tie_payload = {
                "anchor": phrases[current_idx],
                "score": highest_score,
                "candidates": []
            }
            for idx in best_indices:
                current_rem_pos = remaining_indices.index(idx)
                semantic_score = max(0.0, min(1.0, float(sim_scores_cpu[current_rem_pos])))
                w1, w2 = tokenized_phrases[current_idx], tokenized_phrases[idx]
                tie_payload["candidates"].append({
                    "phrase": phrases[idx],
                    "factors": {
                        "semantic": semantic_score,
                        "alignment": compute_custom_alignment(w1, w2),
                        "phrase_matcher": SequenceMatcher(None, phrases[current_idx], phrases[idx]).ratio()
                    }
                })
            
            partial_sorted = [phrases[i] for i in sorted_indices]
            save_phrases(output_file, partial_sorted)
            tie_payload["saved_count"] = len(partial_sorted)

            status_callback("tie", tie_payload)
            return None

        next_idx = best_indices[0]
        remaining_indices.remove(next_idx)
        sorted_indices.append(next_idx)
        LIVE_TELEMETRY.processed_count += 1

    total_run_duration = time.time() - LIVE_TELEMETRY.start_time
    status_callback("success", total_run_duration)
    return [phrases[i] for i in sorted_indices]

class ConsoleTelemetryView:
    def __init__(self):
        self.lines_printed = 0
        self.logs_history = []

    def log_message(self, text):
        self.logs_history.append(text)
        if len(self.logs_history) > 5:
            self.logs_history.pop(0)

    def update(self, data):
        if self.lines_printed > 0:
            sys.stdout.write(f"\033[{self.lines_printed}A")
        
        processed = data["processed"]
        total = data["total"]
        pct = (processed / total * 100) if total > 0 else 0.0
        elapsed = data["elapsed"]

        if processed > 0 and elapsed > 0:
            phrases_per_sec = processed / elapsed
            phrases_per_min = phrases_per_sec * 60
            remaining_count = total - processed
            eta_seconds = remaining_count / phrases_per_sec
            
            if eta_seconds > 3600:
                eta_str = f"{int(eta_seconds // 3600)}h {int((eta_seconds % 3600) // 60)}m"
            elif eta_seconds > 60:
                eta_str = f"{int(eta_seconds // 60)}m {int(eta_seconds % 60)}s"
            else:
                eta_str = f"{eta_seconds:.1f}s"
        else:
            phrases_per_min = 0.0
            eta_str = "Calculating..."

        bar_width = 30
        filled_segments = int(round(bar_width * processed / float(total))) if total > 0 else 0
        text_bar = '█' * filled_segments + '░' * (bar_width - filled_segments)
        progress_bar_str = f"[{text_bar}] {pct:.1f}%"

        out = []
        out.append("=" * 78)
        out.append("            LIVE ACCELERATED SEMANTIC SORTER TERMINAL ENGINE              ")
        out.append("=" * 78)
        out.append(f" Pipeline Progress: {progress_bar_str}")
        out.append(f" Processed Strings: {processed} / {total} items")
        out.append(f" Processing Speed:  {phrases_per_min:.1f} phrases/min  |  {data['ops_per_sec']:.1f} ops/sec")
        out.append(f" Run Duration:      {elapsed:.2f}s   |   ETA: {eta_str}")
        out.append(f" Total Comparisons: {data['comparisons_run']:,}")
        out.append("-" * 78)
        out.append(" Matrix Run Metric Averages:")
        out.append(f"   Semantic CosSim: {data['avg_semantic']:.4f} | Align: {data['avg_align']:.4f} | Matcher: {data['avg_matcher']:.4f}")
        out.append("-" * 78)
        
        anchor_txt = data["current_phrase"]
        if len(anchor_txt) > 58:
            anchor_txt = anchor_txt[:55] + "..."
        out.append(f" Current Loop Anchor: {anchor_txt}")
        out.append("-" * 78)
        
        tier_strings = [f"T{i}: {count}" for i, count in enumerate(data["tiers"])]
        out.append(" Distribution Tiers: " + " | ".join(tier_strings[:5]))
        out.append("                     " + " | ".join(tier_strings[5:]))
        out.append("-" * 78)
        
        out.append(" Top Evaluated Match Candidates:")
        for score, txt in data["top_candidates"]:
            if len(txt) > 60:
                txt = txt[:57] + "..."
            out.append(f"   * [{score:.4f}] {txt}")
        out.append("-" * 78)
        out.append(" System Operations Activity Logs:")
        for log in self.logs_history:
            out.append(f"   >>> {log.strip()}")
        out.append("=" * 78)

        flushed_output = "\n".join(line.ljust(82) for line in out) + "\n"
        sys.stdout.write(flushed_output)
        sys.stdout.flush()

        self.lines_printed = len(out)

def main():
    parser = argparse.ArgumentParser(description="Semantic Similarity Sorter (CLI Edition)")
    parser.add_argument("-i", "--input", type=str, default="sorting_workspace/raw.txt", help="Input file containing pipe-delimited phrases")
    parser.add_argument("-o", "--output", type=str, default="sorting_workspace/sorted.txt", help="Output destination for sorted phrases")
    parser.add_argument("-c", "--cache", type=str, default="sorting_workspace/similarity_cache.pkl", help="Cache file path for operation states")
    parser.add_argument("--w-sem", type=float, default=0.50, help="Weight for Semantic Matching (default: 0.50)")
    parser.add_argument("--w-align", type=float, default=0.30, help="Weight for Custom Alignment (default: 0.30)")
    parser.add_argument("--w-match", type=float, default=0.20, help="Weight for Sequence Matching (default: 0.20)")
    
    args = parser.parse_args()

    weights = {
        "semantic": args.w_sem,
        "alignment": args.w_align,
        "phrase_matcher": args.w_match
    }

    total_w = sum(weights.values())
    if abs(total_w - 1.0) > 1e-4:
        print(f"Warning: Formula weights total {total_w:.2f} instead of exactly 1.00.")

    if not os.path.exists(args.input):
        print(f"Error: Target file '{args.input}' not found.")
        sys.exit(1)

    raw_phrases = load_phrases(args.input)
    if not raw_phrases:
        print("Error: Input contains no active strings or pipe-delimited data.")
        sys.exit(1)

    CACHE_ENGINE.load_cache(args.cache)

    if not load_semantic_model():
        print("Dependency Error: Missing background libraries.\nRun: pip install sentence-transformers torch")
        sys.exit(1)

    console_view = ConsoleTelemetryView()
    console_view.lines_printed = 0
    console_view.logs_history.clear()
    console_view.log_message("Initializing high-speed sorting engine pipeline...")

    def cli_status_callback(event_type, payload):
        if event_type == "embedding_start":
            console_view.log_message("Encoding full global context phrase vectors using MiniLM...")
        elif event_type == "embedding_complete":
            console_view.log_message(f"Phrase context matrices fully generated ({payload:.2f}s).")
        elif event_type == "progress":
            console_view.update(payload)
        elif event_type == "tie":
            console_view.log_message(f"Structural tie encountered at: '{payload['anchor']}'.")
            print(f"\nExecution Halted: Structural tie condition occurred.")
            print(f"Pipeline progress saved up to this phrase iteration in {args.output}")
            sys.exit(1)
        elif event_type == "cancelled":
            console_view.log_message(f"Sorting sequence manually cancelled. Data successfully checkpointed.")
            print(f"\nSorting Cancelled. Sorted elements written to disk within {payload:.2f}s.")
            sys.exit(0)
        elif event_type == "success":
            console_view.log_message(f"Sequence complete! Run duration: {payload:.2f}s.")
            print(f"\nSuccess! Sorting pipeline complete. Total Run Time: {payload:.2f}s")

    try:
        sorted_output = custom_similarity_sort(raw_phrases, args.output, weights, cli_status_callback)
        if sorted_output is not None:
            save_phrases(args.output, sorted_output)
            save_disk_cache()
    except KeyboardInterrupt:
        LIVE_TELEMETRY.is_cancelled = True
        print("\nProcess interrupted by user. Saving progress and exiting...")
        sys.exit(130)

if __name__ == "__main__":
    main()