package main

import (
	"context"
	"sync"
	"time"
)

type scheduler struct {
	mu       sync.Mutex
	interval time.Duration
	next     time.Time
	kick     chan struct{}
}

func newScheduler(interval time.Duration) *scheduler {
	if interval < time.Minute {
		interval = time.Minute
	}
	return &scheduler{
		interval: interval,
		kick:     make(chan struct{}, 1),
	}
}

func (s *scheduler) Run(ctx context.Context) {
	for {
		interval := s.Interval()
		timer := time.NewTimer(interval)
		s.mu.Lock()
		s.next = time.Now().Add(interval)
		s.mu.Unlock()

		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-s.kick:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		case <-timer.C:
			go runSync("scheduled")
		}
	}
}

func (s *scheduler) Interval() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.interval
}

func (s *scheduler) SetInterval(interval time.Duration) {
	if interval < time.Minute {
		interval = time.Minute
	}
	s.mu.Lock()
	s.interval = interval
	s.mu.Unlock()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *scheduler) Next() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.next.IsZero() {
		return time.Now().Add(s.interval)
	}
	return s.next
}
