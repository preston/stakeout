Stakeout::Application.routes.draw do

	resources :dashboards do
		resources :services
	end

	post 'dashboards/active',	as: 'active'
	
	# get "welcome/index",	as: 'home'
	get 'legal' => 'welcome#legal',	as: 'legal'
	get 'about' => 'welcome#about',	as: 'about'

	root to: 'dashboards#index'

end
