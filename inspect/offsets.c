#include <stdio.h>
#include <stddef.h>
#include "udx.h"
#define O(f) printf("\"%s\": %zu,\n", #f, offsetof(udx_stream_t, f))
int main () {
  printf("{\n");
  O(delivered); O(lost); O(app_limited); O(first_sent_ts); O(delivered_ts); O(rate_delivered); O(rate_interval_ms); O(rate_sample_is_app_limited);
  O(srtt); O(rto);
  O(bbr.min_rtt_ms); O(bbr.min_rtt_stamp); O(bbr.probe_rtt_done_time); O(bbr.bw); O(bbr.rtt_count); O(bbr.next_rtt_delivered); O(bbr.cycle_timestamp);
  O(bbr.state); O(bbr.prev_ca_state); O(bbr.use_packet_conservation); O(bbr.round_start); O(bbr.idle_restart); O(bbr.probe_rtt_round_done);
  O(bbr.pacing_gain); O(bbr.cwnd_gain); O(bbr.full_bw_reached); O(bbr.cycle_index); O(bbr.prior_cwnd); O(bbr.full_bw);
  O(bbr.ack_epoch_start); O(bbr.extra_acked); O(bbr.ack_epoch_acked);
  O(rtt_min); O(rack_rtt); O(rack_time_sent); O(pending_timer); O(tlp_is_retrans); O(tlp_in_flight); O(tlp_permitted); O(rttvar); O(fast_recovery_count); O(rto_count); O(seq); O(remote_acked);
  O(pacing_bytes_per_ms); O(tb_available); O(tb_last_refill_ms); O(inflight); O(cwnd); O(send_rwnd); O(mtu); O(retransmit_count);
  printf("\"sizeof_bw_entry\": %zu, \"sizeof\": %zu\n}\n", sizeof(win_filter_f64_entry_t), sizeof(udx_stream_t));
  return 0;
}
